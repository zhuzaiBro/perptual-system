package engine

// 撮合引擎：内存订单簿 + 周期性调用 chain.BuildMatchTradeData / Perpetual.trade。
// 链上角色：私钥地址须为 Dealer.validOrderSender（见 SubmitPerpTrade）。

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"metanode/internal/chain"
	"metanode/internal/config"
	"metanode/internal/model"
	"metanode/internal/svc"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/zeromicro/go-zero/core/logx"
	"github.com/zeromicro/go-zero/core/stores/redis"
)

// MatchEngine 内存撮合 +（可选）链上结算。新进入订单作为 taker，已在簿订单作为 maker。
type MatchEngine struct {
	config     config.MatchEngineConfig
	orderModel model.OrderModel
	tradeModel model.TradeModel
	eventModel model.EngineEventModel
	chain      *chain.Client
	redis      *redis.Redis
	nodeID     string

	// 订单簿：perp -> side -> orders
	orderBooks map[string]*OrderBook
	mu         sync.RWMutex

	// orderId -> 剩余可撮合 paper 绝对值（与链上累计成交量配合；订单对象仍保留签名时的完整 paper/credit）
	remain map[string]*big.Int
	remMu  sync.Mutex

	// 待提交的交易
	pendingTrades []*MatchResult
	tradeMu       sync.Mutex

	leaderMu     sync.RWMutex
	isLeader     bool
	recovered    bool
	eventMu      sync.Mutex
	lastEventSeq int64
	eventQueue   chan *model.EngineEvent

	stopCh chan struct{}
}

// OrderBook 订单簿
type OrderBook struct {
	Perp       string
	BuyOrders  []*model.Order // 买单（做多），按价格从高到低、同价按时间优先排序
	SellOrders []*model.Order // 卖单（做空），按价格从低到高、同价按时间优先排序
	mu         sync.RWMutex
}

// MatchResult 撮合结果
type MatchResult struct {
	MatchID     string
	TakerOrder  *model.Order
	MakerOrder  *model.Order
	MatchAmount string // 成交数量（paper 绝对值）
	MatchPrice  string // 成交价格
}

type orderEventPayload struct {
	Order  *model.Order `json:"order"`
	Remain string       `json:"remain"`
}

type matchEventPayload struct {
	MatchID     string       `json:"matchId"`
	TakerOrder  *model.Order `json:"takerOrder"`
	MakerOrder  *model.Order `json:"makerOrder"`
	MatchAmount string       `json:"matchAmount"`
	MatchPrice  string       `json:"matchPrice"`
}

// NewMatchEngine 创建撮合引擎
func NewMatchEngine(cfg config.MatchEngineConfig, orderModel model.OrderModel, tradeModel model.TradeModel, eventModel model.EngineEventModel, ch *chain.Client, rds *redis.Redis) *MatchEngine {
	return &MatchEngine{
		config:     cfg,
		orderModel: orderModel,
		tradeModel: tradeModel,
		eventModel: eventModel,
		chain:      ch,
		redis:      rds,
		nodeID:     engineNodeID(),
		orderBooks: make(map[string]*OrderBook),
		remain:     make(map[string]*big.Int),
		eventQueue: make(chan *model.EngineEvent, 8192),
		stopCh:     make(chan struct{}),
	}
}

// Start 启动撮合引擎；perpAddresses 用于从 DB 恢复未成交订单。
func (e *MatchEngine) Start(perpAddresses []string) {
	logx.Info("Match engine starting...")
	if e.redis == nil {
		e.setLeader(true)
		e.recoverLeaderState(context.Background(), perpAddresses)
	} else {
		go e.leaderLoop(perpAddresses)
	}
	go e.eventLoop()
	go e.submitLoop()
}

// RestorePendingOrders 重启后从 DB 加载 pending / partial 订单回内存簿。
func (e *MatchEngine) RestorePendingOrders(ctx context.Context, perpAddresses []string) {
	if e.orderModel == nil {
		logx.Error("RestorePendingOrders skipped: order model nil")
		return
	}
	limit := e.config.MaxPendingOrders
	if limit <= 0 {
		limit = 10000
	}
	var restored int
	for _, perp := range perpAddresses {
		perp = strings.TrimSpace(perp)
		if perp == "" {
			continue
		}
		orders, err := e.orderModel.FindPendingOrders(ctx, perp, limit)
		if err != nil {
			logx.Errorf("RestorePendingOrders perp=%s: %v", perp, err)
			continue
		}
		for _, o := range orders {
			full := absPaperString(o.PaperAmount)
			filled, _ := new(big.Int).SetString(o.FilledAmount, 10)
			rem := new(big.Int).Sub(full, filled)
			if rem.Sign() <= 0 {
				continue
			}
			e.restoreOrder(o, rem)
			restored++
		}
	}
	if restored > 0 {
		logx.Infof("Match engine restored %d pending orders from DB", restored)
	}
}

func (e *MatchEngine) recoverLeaderState(ctx context.Context, perpAddresses []string) {
	if !e.hasLeadership() {
		return
	}

	cutSeq := int64(0)
	if e.eventModel != nil {
		seq, err := e.eventModel.LatestSeq(ctx)
		if err != nil {
			logx.Errorf("match engine latest event seq: %v", err)
		} else {
			cutSeq = seq
		}
	}

	e.resetInMemory()
	e.RestorePendingOrders(ctx, perpAddresses)
	e.restoreUnresolvedMatches(ctx)
	e.setLastEventSeq(cutSeq)
	e.setRecovered(true)
	logx.Infof("match engine leader recovered: node=%s seq=%d", e.nodeID, cutSeq)
}

func (e *MatchEngine) resetInMemory() {
	e.mu.Lock()
	e.orderBooks = make(map[string]*OrderBook)
	e.mu.Unlock()

	e.remMu.Lock()
	e.remain = make(map[string]*big.Int)
	e.remMu.Unlock()

	e.tradeMu.Lock()
	e.pendingTrades = nil
	e.tradeMu.Unlock()
}

func (e *MatchEngine) restoreUnresolvedMatches(ctx context.Context) {
	if e.eventModel == nil {
		return
	}
	events, err := e.eventModel.FindUnresolvedMatches(ctx, 10000)
	if err != nil {
		logx.Errorf("restore unresolved matches: %v", err)
		return
	}
	for _, ev := range events {
		trade, err := decodeMatchPayload(ev.Payload)
		if err != nil {
			logx.Errorf("decode unresolved match seq=%d: %v", ev.Seq, err)
			continue
		}
		matchAmt, ok := new(big.Int).SetString(trade.MatchAmount, 10)
		if !ok || matchAmt.Sign() <= 0 {
			continue
		}
		e.reserveRestoredMatch(trade, matchAmt)
		e.queuePendingTrade(trade)
	}
	if len(events) > 0 {
		logx.Infof("match engine restored %d unresolved matches", len(events))
	}
}

func (e *MatchEngine) reserveRestoredMatch(trade *MatchResult, matchAmt *big.Int) {
	book := e.getOrCreateBook(trade.TakerOrder.Perp)
	book.mu.Lock()
	defer book.mu.Unlock()
	for _, order := range []*model.Order{trade.TakerOrder, trade.MakerOrder} {
		if order == nil || e.orderInBook(book, order.OrderId) {
			continue
		}
		full := absPaperString(order.PaperAmount)
		if full.Sign() > 0 {
			e.remMu.Lock()
			if e.remain[order.OrderId] == nil {
				e.remain[order.OrderId] = full
			}
			e.remMu.Unlock()
			e.insertRestingOrderLocked(book, order)
		}
	}

	e.remMu.Lock()
	for _, oid := range []string{trade.TakerOrder.OrderId, trade.MakerOrder.OrderId} {
		if e.remain[oid] != nil {
			e.remain[oid].Sub(e.remain[oid], matchAmt)
			if e.remain[oid].Sign() <= 0 {
				delete(e.remain, oid)
				e.removeOrderFromBookLocked(book, oid)
			}
		}
	}
	e.remMu.Unlock()
}

// Stop 停止撮合引擎
func (e *MatchEngine) Stop() {
	close(e.stopCh)
	e.releaseLeaderLease(context.Background())
}

func engineNodeID() string {
	host, _ := os.Hostname()
	if host == "" {
		host = "unknown-host"
	}
	return fmt.Sprintf("%s-%d-%d", host, os.Getpid(), time.Now().UnixNano())
}

func (e *MatchEngine) leaderLoop(perpAddresses []string) {
	ticker := time.NewTicker(time.Duration(e.leaderRenewSeconds()) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-e.stopCh:
			return
		default:
		}

		if !e.hasLeadership() {
			e.tryBecomeLeader(context.Background(), perpAddresses)
		} else if ok := e.renewLeaderLease(context.Background()); !ok {
			e.setLeader(false)
			logx.Errorf("match engine leader lease lost: node=%s", e.nodeID)
		}

		select {
		case <-e.stopCh:
			return
		case <-ticker.C:
		}
	}
}

func (e *MatchEngine) tryBecomeLeader(ctx context.Context, perpAddresses []string) {
	if e.redis == nil {
		e.setLeader(true)
		return
	}
	ok, err := e.redis.SetnxExCtx(ctx, e.leaderLockKey(), e.nodeID, e.leaderTTLSeconds())
	if err != nil {
		logx.Errorf("match engine leader acquire failed: %v", err)
		return
	}
	if !ok {
		return
	}
	e.setLeader(true)
	e.setRecovered(false)
	logx.Infof("match engine leader acquired: node=%s", e.nodeID)
	e.recoverLeaderState(ctx, perpAddresses)
}

func (e *MatchEngine) renewLeaderLease(ctx context.Context) bool {
	if e.redis == nil {
		return true
	}
	res, err := e.redis.EvalCtx(ctx, `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
end
return 0`, []string{e.leaderLockKey()}, e.nodeID, fmt.Sprintf("%d", e.leaderTTLSeconds()))
	if err != nil {
		logx.Errorf("match engine leader renew failed: %v", err)
		return false
	}
	return res == "OK"
}

func (e *MatchEngine) releaseLeaderLease(ctx context.Context) {
	if e.redis == nil || !e.hasLeadership() {
		return
	}
	_, _ = e.redis.EvalCtx(ctx, `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`, []string{e.leaderLockKey()}, e.nodeID)
	e.setLeader(false)
}

func (e *MatchEngine) leaderLockKey() string {
	key := strings.TrimSpace(e.config.LeaderLockKey)
	if key == "" {
		return "metanode:match-engine:leader"
	}
	return key
}

func (e *MatchEngine) leaderTTLSeconds() int {
	if e.config.LeaderLockTTLSeconds > 0 {
		return e.config.LeaderLockTTLSeconds
	}
	return 15
}

func (e *MatchEngine) leaderRenewSeconds() int {
	if e.config.LeaderRenewSeconds > 0 {
		return e.config.LeaderRenewSeconds
	}
	ttl := e.leaderTTLSeconds()
	if ttl <= 2 {
		return 1
	}
	return ttl / 3
}

func (e *MatchEngine) eventPollInterval() time.Duration {
	if e.config.EventPollIntervalMs > 0 {
		return time.Duration(e.config.EventPollIntervalMs) * time.Millisecond
	}
	return 200 * time.Millisecond
}

func (e *MatchEngine) matchInterval() time.Duration {
	if e.config.MatchInterval > 0 {
		return time.Duration(e.config.MatchInterval) * time.Millisecond
	}
	return 100 * time.Millisecond
}

func (e *MatchEngine) setLeader(active bool) {
	e.leaderMu.Lock()
	e.isLeader = active
	if !active {
		e.recovered = false
	}
	e.leaderMu.Unlock()
}

func (e *MatchEngine) hasLeadership() bool {
	if e.redis == nil {
		return true
	}
	e.leaderMu.RLock()
	defer e.leaderMu.RUnlock()
	return e.isLeader
}

func (e *MatchEngine) setRecovered(ok bool) {
	e.leaderMu.Lock()
	e.recovered = ok
	e.leaderMu.Unlock()
}

func (e *MatchEngine) isRecovered() bool {
	if e.redis == nil {
		return true
	}
	e.leaderMu.RLock()
	defer e.leaderMu.RUnlock()
	return e.recovered
}

func absPaperString(paper string) *big.Int {
	z := new(big.Int)
	if _, ok := z.SetString(paper, 10); !ok {
		return big.NewInt(0)
	}
	z.Abs(z)
	return z
}

func orderExpired(o *model.Order, now int64) bool {
	if o == nil {
		return true
	}
	return o.Expiration <= now
}

func (e *MatchEngine) dropExpiredLocked(book *OrderBook, side string, idx int, o *model.Order) {
	switch side {
	case "buy":
		book.BuyOrders = append(book.BuyOrders[:idx], book.BuyOrders[idx+1:]...)
	case "sell":
		book.SellOrders = append(book.SellOrders[:idx], book.SellOrders[idx+1:]...)
	}
	e.remMu.Lock()
	delete(e.remain, o.OrderId)
	e.remMu.Unlock()
	if e.orderModel != nil {
		_ = e.orderModel.UpdateStatus(context.Background(), o.OrderId, model.OrderStatusCancelled, o.FilledAmount)
	}
	logx.Infof("expired order removed from book: %s expiration=%d", o.OrderId, o.Expiration)
}

// pruneExpired 移除过期单，避免深度展示脏数据或链上反复 revert。
func (e *MatchEngine) pruneExpired(book *OrderBook) {
	now := time.Now().Unix()
	for i := 0; i < len(book.BuyOrders); {
		if orderExpired(book.BuyOrders[i], now) {
			e.dropExpiredLocked(book, "buy", i, book.BuyOrders[i])
			continue
		}
		i++
	}
	for i := 0; i < len(book.SellOrders); {
		if orderExpired(book.SellOrders[i], now) {
			e.dropExpiredLocked(book, "sell", i, book.SellOrders[i])
			continue
		}
		i++
	}
}

// AddOrder 持久化订单接收事件，并投递给 leader 的单线程事件循环。
func (e *MatchEngine) AddOrder(order *model.Order) error {
	if order == nil {
		return fmt.Errorf("nil order")
	}
	remain := absPaperString(order.PaperAmount)
	if e.eventModel != nil {
		ev, err := e.appendOrderEvent(context.Background(), order, remain)
		if err != nil {
			return err
		}
		if e.hasLeadership() {
			e.enqueueLocalEvent(ev)
		}
		return nil
	}
	if e.hasLeadership() {
		e.matchIncomingOrder(order, remain)
	}
	return nil
}

// RemoveOrder 持久化取消事件，并投递给 leader 的单线程事件循环。
func (e *MatchEngine) RemoveOrder(orderID string) bool {
	orderID = strings.TrimSpace(orderID)
	if orderID == "" {
		return false
	}
	if e.eventModel != nil {
		ev, err := e.appendSimpleEvent(context.Background(), model.EngineEventOrderCanceled, orderID, "", "", map[string]string{"orderId": orderID})
		if err != nil {
			logx.Errorf("append cancel event: %v", err)
			return false
		}
		if e.hasLeadership() {
			e.enqueueLocalEvent(ev)
		}
		return true
	}
	return e.removeOrderInMemory(orderID)
}

func (e *MatchEngine) removeOrderInMemory(orderID string) bool {
	e.mu.RLock()
	books := make([]*OrderBook, 0, len(e.orderBooks))
	for _, book := range e.orderBooks {
		books = append(books, book)
	}
	e.mu.RUnlock()

	for _, book := range books {
		if book == nil {
			continue
		}
		book.mu.Lock()
		removed := false
		for i, o := range book.BuyOrders {
			if o != nil && o.OrderId == orderID {
				book.BuyOrders = append(book.BuyOrders[:i], book.BuyOrders[i+1:]...)
				removed = true
				break
			}
		}
		if !removed {
			for i, o := range book.SellOrders {
				if o != nil && o.OrderId == orderID {
					book.SellOrders = append(book.SellOrders[:i], book.SellOrders[i+1:]...)
					removed = true
					break
				}
			}
		}
		book.mu.Unlock()
		if removed {
			e.remMu.Lock()
			delete(e.remain, orderID)
			e.remMu.Unlock()
			return true
		}
	}
	return false
}

func (e *MatchEngine) eventLoop() {
	pollTicker := time.NewTicker(e.eventPollInterval())
	defer pollTicker.Stop()
	matchTicker := time.NewTicker(e.matchInterval())
	defer matchTicker.Stop()
	for {
		select {
		case <-e.stopCh:
			return
		case ev := <-e.eventQueue:
			if e.hasLeadership() && e.isRecovered() {
				if e.eventModel != nil {
					e.pollEngineEvents(context.Background())
				} else {
					e.consumeEngineEvent(ev)
				}
				e.match()
			}
		case <-pollTicker.C:
			if e.hasLeadership() && e.isRecovered() {
				e.pollEngineEvents(context.Background())
				e.match()
			}
		case <-matchTicker.C:
			if e.hasLeadership() && e.isRecovered() {
				e.match()
			}
		}
	}
}

func (e *MatchEngine) enqueueLocalEvent(ev *model.EngineEvent) {
	if ev == nil {
		return
	}
	select {
	case e.eventQueue <- ev:
	default:
		logx.Errorf("match engine event queue full, seq=%d type=%s will be picked by poller", ev.Seq, ev.EventType)
	}
}

func (e *MatchEngine) pollEngineEvents(ctx context.Context) {
	if e.eventModel == nil {
		return
	}
	last := e.getLastEventSeq()
	events, err := e.eventModel.ListAfter(ctx, last, 500)
	if err != nil {
		logx.Errorf("poll engine events: %v", err)
		return
	}
	for _, ev := range events {
		if ok := e.consumeEngineEvent(ev); !ok {
			return
		}
	}
}

func (e *MatchEngine) consumeEngineEvent(ev *model.EngineEvent) bool {
	if ev == nil || ev.Seq <= e.getLastEventSeq() {
		return true
	}
	if err := e.applyEngineEvent(ev); err != nil {
		logx.Errorf("apply engine event seq=%d type=%s: %v", ev.Seq, ev.EventType, err)
		return false
	}
	e.setLastEventSeq(ev.Seq)
	return true
}

func (e *MatchEngine) applyEngineEvent(ev *model.EngineEvent) error {
	switch ev.EventType {
	case model.EngineEventOrderAccepted:
		var payload orderEventPayload
		if err := json.Unmarshal([]byte(ev.Payload), &payload); err != nil {
			return err
		}
		if payload.Order == nil {
			return fmt.Errorf("order event missing order")
		}
		remain := absPaperString(payload.Order.PaperAmount)
		if payload.Remain != "" {
			if r, ok := new(big.Int).SetString(payload.Remain, 10); ok && r.Sign() > 0 {
				remain = r
			}
		}
		e.matchIncomingOrder(payload.Order, remain)
	case model.EngineEventOrderCanceled:
		_ = e.removeOrderInMemory(ev.OrderId)
	case model.EngineEventMatchRollback:
		trade, err := decodeMatchPayload(ev.Payload)
		if err != nil {
			return err
		}
		matchAmt, ok := new(big.Int).SetString(trade.MatchAmount, 10)
		if !ok || matchAmt.Sign() <= 0 {
			return fmt.Errorf("invalid rollback amount %s", trade.MatchAmount)
		}
		e.applyRollbackMatch(trade, matchAmt)
	}
	return nil
}

func (e *MatchEngine) appendOrderEvent(ctx context.Context, order *model.Order, remain *big.Int) (*model.EngineEvent, error) {
	payload := orderEventPayload{Order: order, Remain: remain.String()}
	return e.appendSimpleEvent(ctx, model.EngineEventOrderAccepted, order.OrderId, "", order.Perp, payload)
}

func (e *MatchEngine) appendMatchEvent(ctx context.Context, eventType string, trade *MatchResult) (*model.EngineEvent, error) {
	payload := matchEventPayload{
		MatchID:     trade.MatchID,
		TakerOrder:  trade.TakerOrder,
		MakerOrder:  trade.MakerOrder,
		MatchAmount: trade.MatchAmount,
		MatchPrice:  trade.MatchPrice,
	}
	return e.appendSimpleEvent(ctx, eventType, "", trade.MatchID, trade.TakerOrder.Perp, payload)
}

func (e *MatchEngine) appendSimpleEvent(ctx context.Context, eventType, orderID, matchID, perp string, payload any) (*model.EngineEvent, error) {
	if e.eventModel == nil {
		return nil, nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	ev := &model.EngineEvent{
		EventType:  eventType,
		OrderId:    orderID,
		MatchId:    matchID,
		Perp:       perp,
		Payload:    string(raw),
		NodeId:     e.nodeID,
		CreateTime: time.Now().UTC(),
	}
	_, err = e.eventModel.Append(ctx, ev)
	if err != nil {
		return nil, err
	}
	return ev, nil
}

func decodeMatchPayload(raw string) (*MatchResult, error) {
	var payload matchEventPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, err
	}
	if payload.TakerOrder == nil || payload.MakerOrder == nil {
		return nil, fmt.Errorf("match payload missing orders")
	}
	return &MatchResult{
		MatchID:     payload.MatchID,
		TakerOrder:  payload.TakerOrder,
		MakerOrder:  payload.MakerOrder,
		MatchAmount: payload.MatchAmount,
		MatchPrice:  payload.MatchPrice,
	}, nil
}

func (e *MatchEngine) getLastEventSeq() int64 {
	e.eventMu.Lock()
	defer e.eventMu.Unlock()
	return e.lastEventSeq
}

func (e *MatchEngine) setLastEventSeq(seq int64) {
	e.eventMu.Lock()
	if seq > e.lastEventSeq {
		e.lastEventSeq = seq
	}
	e.eventMu.Unlock()
}

func (e *MatchEngine) restoreOrder(order *model.Order, remain *big.Int) {
	if remain == nil || remain.Sign() <= 0 {
		return
	}
	e.addOrderWithRemain(order, new(big.Int).Set(remain))
}

func (e *MatchEngine) addOrderWithRemain(order *model.Order, remain *big.Int) {
	e.remMu.Lock()
	e.remain[order.OrderId] = new(big.Int).Set(remain)
	e.remMu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()

	orderBook, ok := e.orderBooks[order.Perp]
	if !ok {
		orderBook = &OrderBook{Perp: order.Perp}
		e.orderBooks[order.Perp] = orderBook
	}

	orderBook.mu.Lock()
	defer orderBook.mu.Unlock()

	if e.orderInBook(orderBook, order.OrderId) {
		return
	}

	e.insertRestingOrderLocked(orderBook, order)
}

func (e *MatchEngine) matchIncomingOrder(order *model.Order, remaining *big.Int) {
	if order == nil || remaining == nil || remaining.Sign() <= 0 || orderExpired(order, time.Now().Unix()) {
		return
	}

	book := e.getOrCreateBook(order.Perp)
	book.mu.Lock()
	defer book.mu.Unlock()

	if e.orderInBook(book, order.OrderId) {
		return
	}
	e.pruneExpired(book)

	remaining = e.matchAgainstRestingLocked(book, order, remaining)
	if remaining.Sign() > 0 {
		e.remMu.Lock()
		e.remain[order.OrderId] = new(big.Int).Set(remaining)
		e.remMu.Unlock()
		e.insertRestingOrderLocked(book, order)
	}
}

func (e *MatchEngine) getOrCreateBook(perp string) *OrderBook {
	e.mu.Lock()
	defer e.mu.Unlock()
	book, ok := e.orderBooks[perp]
	if !ok {
		book = &OrderBook{Perp: perp}
		e.orderBooks[perp] = book
	}
	return book
}

func (e *MatchEngine) matchAgainstRestingLocked(book *OrderBook, taker *model.Order, takerRemaining *big.Int) *big.Int {
	takerPaper := parseBigInt(taker.PaperAmount)
	if takerPaper.Sign() == 0 {
		return big.NewInt(0)
	}
	takerPrice := calculatePrice(taker)
	if takerPrice.Sign() <= 0 {
		return takerRemaining
	}

	if takerPaper.Sign() > 0 {
		for takerRemaining.Sign() > 0 {
			maker, idx, ok := e.nextMatchableMakerLocked(book.SellOrders, taker, takerPrice, false)
			if !ok {
				break
			}
			makerRemaining := e.remainingOf(maker.OrderId)
			if makerRemaining.Sign() <= 0 {
				book.SellOrders = append(book.SellOrders[:idx], book.SellOrders[idx+1:]...)
				continue
			}
			matchAmount := minBig(takerRemaining, makerRemaining)
			if _, err := e.enqueueMatch(taker, maker, matchAmount, calculatePrice(maker)); err != nil {
				logx.Errorf("enqueue match failed: %v", err)
				break
			}
			takerRemaining.Sub(takerRemaining, matchAmount)
			e.decreaseRestingLocked(book, "sell", idx, maker.OrderId, matchAmount)
		}
		return takerRemaining
	}

	for takerRemaining.Sign() > 0 {
		maker, idx, ok := e.nextMatchableMakerLocked(book.BuyOrders, taker, takerPrice, true)
		if !ok {
			break
		}
		makerRemaining := e.remainingOf(maker.OrderId)
		if makerRemaining.Sign() <= 0 {
			book.BuyOrders = append(book.BuyOrders[:idx], book.BuyOrders[idx+1:]...)
			continue
		}
		matchAmount := minBig(takerRemaining, makerRemaining)
		if _, err := e.enqueueMatch(taker, maker, matchAmount, calculatePrice(maker)); err != nil {
			logx.Errorf("enqueue match failed: %v", err)
			break
		}
		takerRemaining.Sub(takerRemaining, matchAmount)
		e.decreaseRestingLocked(book, "buy", idx, maker.OrderId, matchAmount)
	}
	return takerRemaining
}

func (e *MatchEngine) nextMatchableMakerLocked(orders []*model.Order, taker *model.Order, takerPrice *big.Int, makerBuySide bool) (*model.Order, int, bool) {
	for i, maker := range orders {
		if maker == nil {
			continue
		}
		if strings.EqualFold(maker.Signer, taker.Signer) {
			continue
		}
		makerPrice := calculatePrice(maker)
		if makerBuySide {
			if makerPrice.Cmp(takerPrice) < 0 {
				return nil, 0, false
			}
		} else if makerPrice.Cmp(takerPrice) > 0 {
			return nil, 0, false
		}
		return maker, i, true
	}
	return nil, 0, false
}

func (e *MatchEngine) enqueueMatch(taker, maker *model.Order, amount, price *big.Int) (*MatchResult, error) {
	result := &MatchResult{
		MatchID:     generateMatchId(),
		TakerOrder:  taker,
		MakerOrder:  maker,
		MatchAmount: amount.String(),
		MatchPrice:  price.String(),
	}
	if e.eventModel != nil {
		_, err := e.appendMatchEvent(context.Background(), model.EngineEventMatchEnqueued, result)
		if err != nil {
			return nil, err
		}
	}
	e.queuePendingTrade(result)
	return result, nil
}

func (e *MatchEngine) queuePendingTrade(result *MatchResult) {
	e.tradeMu.Lock()
	e.pendingTrades = append(e.pendingTrades, result)
	e.tradeMu.Unlock()
}

func (e *MatchEngine) decreaseRestingLocked(book *OrderBook, side string, idx int, orderID string, amount *big.Int) {
	e.remMu.Lock()
	rem := e.remain[orderID]
	if rem == nil {
		e.remMu.Unlock()
		return
	}
	rem.Sub(rem, amount)
	filled := rem.Sign() <= 0
	if filled {
		delete(e.remain, orderID)
	}
	e.remMu.Unlock()

	if filled {
		switch side {
		case "buy":
			book.BuyOrders = append(book.BuyOrders[:idx], book.BuyOrders[idx+1:]...)
		case "sell":
			book.SellOrders = append(book.SellOrders[:idx], book.SellOrders[idx+1:]...)
		}
	}
}

func (e *MatchEngine) removeOrderFromBookLocked(book *OrderBook, orderID string) {
	for i, o := range book.BuyOrders {
		if o != nil && o.OrderId == orderID {
			book.BuyOrders = append(book.BuyOrders[:i], book.BuyOrders[i+1:]...)
			return
		}
	}
	for i, o := range book.SellOrders {
		if o != nil && o.OrderId == orderID {
			book.SellOrders = append(book.SellOrders[:i], book.SellOrders[i+1:]...)
			return
		}
	}
}

func (e *MatchEngine) remainingOf(orderID string) *big.Int {
	e.remMu.Lock()
	defer e.remMu.Unlock()
	rem := e.remain[orderID]
	if rem == nil {
		return big.NewInt(0)
	}
	return new(big.Int).Set(rem)
}

func minBig(a, b *big.Int) *big.Int {
	if a.Cmp(b) < 0 {
		return new(big.Int).Set(a)
	}
	return new(big.Int).Set(b)
}

func parseBigInt(s string) *big.Int {
	z := new(big.Int)
	if _, ok := z.SetString(strings.TrimSpace(s), 10); !ok {
		return big.NewInt(0)
	}
	return z
}

func (e *MatchEngine) orderInBook(book *OrderBook, orderID string) bool {
	for _, o := range book.BuyOrders {
		if o.OrderId == orderID {
			return true
		}
	}
	for _, o := range book.SellOrders {
		if o.OrderId == orderID {
			return true
		}
	}
	return false
}

// match 执行撮合
func (e *MatchEngine) match() {
	e.mu.RLock()
	defer e.mu.RUnlock()

	for _, orderBook := range e.orderBooks {
		e.matchOrderBook(orderBook)
	}
}

// matchOrderBook 撮合单个订单簿
func (e *MatchEngine) matchOrderBook(book *OrderBook) {
	book.mu.Lock()
	defer book.mu.Unlock()

	for {
		e.pruneExpired(book)
		if len(book.BuyOrders) == 0 || len(book.SellOrders) == 0 {
			break
		}

		buyOrder := book.BuyOrders[0]
		sellOrder := book.SellOrders[0]

		buyPrice := calculatePrice(buyOrder)
		sellPrice := calculatePrice(sellOrder)

		if buyPrice.Cmp(sellPrice) < 0 {
			break
		}

		if strings.EqualFold(buyOrder.Signer, sellOrder.Signer) {
			break
		}

		buyRem := e.remainingOf(buyOrder.OrderId)
		sellRem := e.remainingOf(sellOrder.OrderId)

		matchAmount := new(big.Int)
		if buyRem.Cmp(sellRem) < 0 {
			matchAmount.Set(buyRem)
		} else {
			matchAmount.Set(sellRem)
		}
		if matchAmount.Sign() == 0 {
			break
		}

		takerOrder := buyOrder
		makerOrder := sellOrder
		makerPrice := sellPrice
		if orderOlder(buyOrder, sellOrder) {
			takerOrder = sellOrder
			makerOrder = buyOrder
			makerPrice = buyPrice
		}
		if _, err := e.enqueueMatch(takerOrder, makerOrder, matchAmount, makerPrice); err != nil {
			logx.Errorf("enqueue match failed: %v", err)
			break
		}

		e.remMu.Lock()
		if e.remain[buyOrder.OrderId] != nil {
			e.remain[buyOrder.OrderId].Sub(e.remain[buyOrder.OrderId], matchAmount)
		}
		if e.remain[sellOrder.OrderId] != nil {
			e.remain[sellOrder.OrderId].Sub(e.remain[sellOrder.OrderId], matchAmount)
		}
		if e.remain[buyOrder.OrderId] == nil || e.remain[buyOrder.OrderId].Sign() <= 0 {
			book.BuyOrders = book.BuyOrders[1:]
			delete(e.remain, buyOrder.OrderId)
		}
		if e.remain[sellOrder.OrderId] == nil || e.remain[sellOrder.OrderId].Sign() <= 0 {
			book.SellOrders = book.SellOrders[1:]
			delete(e.remain, sellOrder.OrderId)
		}
		e.remMu.Unlock()
	}
}

// submitLoop 提交交易循环
func (e *MatchEngine) submitLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-e.stopCh:
			return
		case <-ticker.C:
			if e.hasLeadership() && e.isRecovered() {
				e.submitTrades()
			}
		}
	}
}

// submitTrades 提交交易到链上
func (e *MatchEngine) submitTrades() {
	e.tradeMu.Lock()
	if len(e.pendingTrades) == 0 {
		e.tradeMu.Unlock()
		return
	}

	trades := e.pendingTrades
	e.pendingTrades = nil
	e.tradeMu.Unlock()

	batch := make([]*MatchResult, 0, e.config.BatchSize)
	for _, trade := range trades {
		batch = append(batch, trade)
		if len(batch) >= e.config.BatchSize {
			e.submitBatch(batch)
			batch = batch[:0]
		}
	}
	if len(batch) > 0 {
		e.submitBatch(batch)
	}
}

// submitBatch 对每笔撮合：编码 tradeData → Perpetual.trade → 等待收据；链上成功才更新 DB。
func (e *MatchEngine) submitBatch(trades []*MatchResult) {
	if e.orderModel == nil || e.tradeModel == nil {
		logx.Error("order/trade model nil, rollback in-memory matches")
		for _, trade := range trades {
			if matchAmt, ok := new(big.Int).SetString(trade.MatchAmount, 10); ok {
				e.rollbackMatch(trade, matchAmt)
			}
		}
		return
	}
	ctx := context.Background()
	for _, trade := range trades {
		matchAmt, ok := new(big.Int).SetString(trade.MatchAmount, 10)
		if !ok {
			logx.Errorf("bad match amount %s", trade.MatchAmount)
			continue
		}

		if e.chain == nil {
			logx.Error("chain client nil, rollback match (no on-chain settle)")
			e.rollbackMatch(trade, matchAmt)
			continue
		}

		now := time.Now().Unix()
		if orderExpired(trade.TakerOrder, now) || orderExpired(trade.MakerOrder, now) {
			logx.Errorf("skip on-chain trade: order expired taker=%s maker=%s", trade.TakerOrder.OrderId, trade.MakerOrder.OrderId)
			e.rollbackMatch(trade, matchAmt)
			continue
		}

		td, err := chain.BuildMatchTradeData(trade.TakerOrder, trade.MakerOrder, matchAmt)
		if err != nil {
			logx.Errorf("build trade data: %v", err)
			e.rollbackMatch(trade, matchAmt)
			continue
		}

		perp := common.HexToAddress(trade.TakerOrder.Perp)
		tx, err := e.chain.SubmitPerpTrade(ctx, perp, td)
		if err != nil {
			logx.Errorf("SubmitPerpTrade failed: %v", err)
			e.rollbackMatch(trade, matchAmt)
			continue
		}

		txHash := tx.Hash().Hex()
		rec, err := bind.WaitMined(ctx, e.chain.RPC(), tx)
		if err != nil {
			logx.Errorf("WaitMined %s: %v", txHash, err)
			e.rollbackMatch(trade, matchAmt)
			continue
		}
		if rec == nil || rec.Status != 1 {
			logx.Errorf("trade tx reverted or failed: %s status=%v", txHash, recStatus(rec))
			e.rollbackMatch(trade, matchAmt)
			continue
		}

		blockNum := int64(rec.BlockNumber.Uint64())
		e.applyFillStatus(ctx, trade.TakerOrder.OrderId, trade.TakerOrder.PaperAmount, matchAmt.String())
		e.applyFillStatus(ctx, trade.MakerOrder.OrderId, trade.MakerOrder.PaperAmount, matchAmt.String())
		if e.eventModel != nil {
			if _, err := e.appendMatchEvent(ctx, model.EngineEventMatchSettled, trade); err != nil {
				logx.Errorf("append match settled event: %v", err)
			}
		}

		if _, err := e.tradeModel.Insert(ctx, &model.Trade{
			TradeId:      generateTradeId(),
			Perp:         trade.TakerOrder.Perp,
			TakerOrderId: trade.TakerOrder.OrderId,
			MakerOrderId: trade.MakerOrder.OrderId,
			Taker:        trade.TakerOrder.Signer,
			Maker:        trade.MakerOrder.Signer,
			PaperAmount:  trade.MatchAmount,
			Price:        trade.MatchPrice,
			TxHash:       txHash,
			BlockNumber:  blockNum,
			CreateTime:   time.Now(),
		}); err != nil {
			logx.Errorf("insert trade: %v", err)
		} else {
			logx.Infof("trade settled on-chain: tx=%s perp=%s amount=%s", txHash, trade.TakerOrder.Perp, matchAmt.String())
		}
	}
}

func recStatus(rec *types.Receipt) uint64 {
	if rec == nil {
		return 0
	}
	return rec.Status
}

func (e *MatchEngine) rollbackMatch(trade *MatchResult, matchAmt *big.Int) {
	if trade == nil || matchAmt == nil || matchAmt.Sign() <= 0 {
		return
	}
	if e.eventModel != nil && trade.MatchID != "" {
		ev, err := e.appendMatchEvent(context.Background(), model.EngineEventMatchRollback, trade)
		if err != nil {
			logx.Errorf("append match rollback event: %v", err)
			return
		}
		if e.hasLeadership() {
			e.enqueueLocalEvent(ev)
		}
		return
	}
	e.applyRollbackMatch(trade, matchAmt)
}

func (e *MatchEngine) applyRollbackMatch(trade *MatchResult, matchAmt *big.Int) {
	book := e.getOrCreateBook(trade.TakerOrder.Perp)
	book.mu.Lock()
	defer book.mu.Unlock()

	e.remMu.Lock()
	for _, oid := range []string{trade.TakerOrder.OrderId, trade.MakerOrder.OrderId} {
		if e.remain[oid] == nil {
			e.remain[oid] = big.NewInt(0)
		}
		e.remain[oid].Add(e.remain[oid], matchAmt)
	}
	e.remMu.Unlock()

	if !e.orderInBook(book, trade.TakerOrder.OrderId) {
		e.reinsertOrderLocked(book, trade.TakerOrder)
	}
	if !e.orderInBook(book, trade.MakerOrder.OrderId) {
		e.reinsertOrderLocked(book, trade.MakerOrder)
	}
	logx.Infof("match rolled back in memory: taker=%s maker=%s amount=%s", trade.TakerOrder.OrderId, trade.MakerOrder.OrderId, matchAmt.String())
}

func (e *MatchEngine) reinsertOrderLocked(book *OrderBook, order *model.Order) {
	e.insertRestingOrderLocked(book, order)
}

func (e *MatchEngine) insertRestingOrderLocked(book *OrderBook, order *model.Order) {
	paperAmount := parseBigInt(order.PaperAmount)
	if paperAmount.Sign() > 0 {
		book.BuyOrders = append(book.BuyOrders, order)
		sort.SliceStable(book.BuyOrders, func(i, j int) bool {
			return bookOrderLess(book.BuyOrders[i], book.BuyOrders[j], true)
		})
	} else {
		book.SellOrders = append(book.SellOrders, order)
		sort.SliceStable(book.SellOrders, func(i, j int) bool {
			return bookOrderLess(book.SellOrders[i], book.SellOrders[j], false)
		})
	}
}

func bookOrderLess(a, b *model.Order, buySide bool) bool {
	priceA := calculatePrice(a)
	priceB := calculatePrice(b)
	cmp := priceA.Cmp(priceB)
	if cmp != 0 {
		if buySide {
			return cmp > 0
		}
		return cmp < 0
	}
	if !a.CreateTime.Equal(b.CreateTime) {
		return a.CreateTime.Before(b.CreateTime)
	}
	return a.OrderId < b.OrderId
}

func orderOlder(a, b *model.Order) bool {
	if !a.CreateTime.Equal(b.CreateTime) {
		return a.CreateTime.Before(b.CreateTime)
	}
	if a.Id != b.Id {
		return a.Id < b.Id
	}
	return a.OrderId < b.OrderId
}

func (e *MatchEngine) applyFillStatus(ctx context.Context, orderID, signedPaper, deltaStr string) {
	// 按订单原始签名数量累计 filled；达到全额则 Status=Filled，否则 PartialFill。
	o, err := e.orderModel.FindOne(ctx, orderID)
	if err != nil || o == nil {
		return
	}
	full := absPaperString(signedPaper)
	delta, _ := new(big.Int).SetString(deltaStr, 10)
	prev, _ := new(big.Int).SetString(o.FilledAmount, 10)
	total := new(big.Int).Add(prev, delta)
	status := model.OrderStatusPartialFill
	if total.Cmp(full) >= 0 {
		status = model.OrderStatusFilled
		total.Set(full)
	}
	_ = e.orderModel.UpdateStatus(ctx, orderID, status, total.String())
}

// calculatePrice 计算订单价格 |credit|/|paper|（1e18 精度）
func calculatePrice(order *model.Order) *big.Int {
	paper := new(big.Int)
	paper.SetString(order.PaperAmount, 10)
	paper.Abs(paper)

	credit := new(big.Int)
	credit.SetString(order.CreditAmount, 10)
	credit.Abs(credit)

	if paper.Sign() == 0 {
		return big.NewInt(0)
	}

	precision := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	price := new(big.Int).Mul(credit, precision)
	price.Div(price, paper)
	return price
}

func generateTradeId() string {
	return time.Now().Format("20060102150405") + randomString(8)
}

func generateMatchId() string {
	return "m_" + generateTradeId()
}

// MidMarkPrice 展示用合约价：双边盘口为 (买一+卖一)/2；单边盘口用最优买一或卖一。
func (e *MatchEngine) MidMarkPrice(perp string) (price string, ok bool) {
	bids, asks := e.SnapshotOrderBook(perp, 1)
	var bid, ask *big.Int
	if len(bids) > 0 {
		bid, ok = new(big.Int).SetString(bids[0].Price, 10)
		if !ok || bid.Sign() <= 0 {
			bid = nil
		}
	}
	if len(asks) > 0 {
		ask, ok = new(big.Int).SetString(asks[0].Price, 10)
		if !ok || ask.Sign() <= 0 {
			ask = nil
		}
	}
	switch {
	case bid != nil && ask != nil:
		mid := new(big.Int).Add(bid, ask)
		mid.Div(mid, big.NewInt(2))
		return mid.String(), true
	case bid != nil:
		return bid.String(), true
	case ask != nil:
		return ask.String(), true
	default:
		return "", false
	}
}

// SnapshotOrderBook 返回内存订单簿聚合深度（price 为 |credit|/|paper| 的整数价格字符串）。
func (e *MatchEngine) SnapshotOrderBook(perp string, limit int) (bids, asks []svc.OrderBookLevel) {
	if limit <= 0 {
		limit = 20
	}
	perp = strings.TrimSpace(perp)
	if perp == "" {
		return nil, nil
	}

	e.mu.RLock()
	book, ok := e.orderBooks[perp]
	e.mu.RUnlock()
	if !ok || book == nil {
		return nil, nil
	}

	book.mu.RLock()
	defer book.mu.RUnlock()

	e.remMu.Lock()
	defer e.remMu.Unlock()

	bidMap := aggregateBookLevels(book.BuyOrders, e.remain)
	askMap := aggregateBookLevels(book.SellOrders, e.remain)

	bids = levelsFromMap(bidMap, limit, true)
	asks = levelsFromMap(askMap, limit, false)
	return bids, asks
}

func aggregateBookLevels(orders []*model.Order, remain map[string]*big.Int) map[string]*big.Int {
	out := make(map[string]*big.Int)
	for _, o := range orders {
		if o == nil {
			continue
		}
		rem := remain[o.OrderId]
		if rem == nil || rem.Sign() <= 0 {
			continue
		}
		price := calculatePrice(o).String()
		if out[price] == nil {
			out[price] = new(big.Int)
		}
		out[price].Add(out[price], rem)
	}
	return out
}

func levelsFromMap(m map[string]*big.Int, limit int, desc bool) []svc.OrderBookLevel {
	if len(m) == 0 {
		return nil
	}
	prices := make([]string, 0, len(m))
	for p := range m {
		prices = append(prices, p)
	}
	sort.Slice(prices, func(i, j int) bool {
		pi, _ := new(big.Int).SetString(prices[i], 10)
		pj, _ := new(big.Int).SetString(prices[j], 10)
		if desc {
			return pi.Cmp(pj) > 0
		}
		return pi.Cmp(pj) < 0
	})
	if len(prices) > limit {
		prices = prices[:limit]
	}
	out := make([]svc.OrderBookLevel, 0, len(prices))
	for _, p := range prices {
		out = append(out, svc.OrderBookLevel{
			Price:  p,
			Amount: m[p].String(),
		})
	}
	return out
}

func randomString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[time.Now().UnixNano()%int64(len(letters))]
	}
	return string(b)
}
