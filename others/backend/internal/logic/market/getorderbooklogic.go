package market

import (
	"context"
	"math/big"
	"sort"
	"strings"

	"metanode/internal/model"
	"metanode/internal/svc"
	"metanode/internal/types"

	"github.com/zeromicro/go-zero/core/logx"
)

type GetOrderBookLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

// 获取深度
func NewGetOrderBookLogic(ctx context.Context, svcCtx *svc.ServiceContext) *GetOrderBookLogic {
	return &GetOrderBookLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *GetOrderBookLogic) GetOrderBook(req *types.GetOrderBookReq) (resp *types.GetOrderBookResp, err error) {
	perp := strings.TrimSpace(req.Perp)
	if perp == "" {
		return &types.GetOrderBookResp{Code: 400, Message: "perp is required"}, nil
	}
	limit := req.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	var bids, asks []types.OrderBookEntry
	if l.svcCtx.OrderModel != nil {
		queryLimit := l.svcCtx.Config.MatchEngine.MaxPendingOrders
		if queryLimit <= 0 {
			queryLimit = 10000
		}
		orders, queryErr := l.svcCtx.OrderModel.FindPendingOrders(l.ctx, perp, queryLimit)
		if queryErr != nil {
			l.Errorf("GetOrderBook pending orders perp=%s: %v", perp, queryErr)
		} else {
			rawBids, rawAsks := pendingOrdersToLevels(orders, limit)
			bids = toOrderBookEntries(rawBids)
			asks = toOrderBookEntries(rawAsks)
		}
	}
	// 数据库查询异常时回退到内存簿；数据库是未成交状态的权威来源，
	// 能避免订单在链上结算中暂时移出内存簿时深度区域闪空。
	if bids == nil && asks == nil && l.svcCtx.OrderBook != nil {
		rawBids, rawAsks := l.svcCtx.OrderBook.SnapshotOrderBook(perp, limit)
		bids = toOrderBookEntries(rawBids)
		asks = toOrderBookEntries(rawAsks)
	}
	if bids == nil {
		bids = []types.OrderBookEntry{}
	}
	if asks == nil {
		asks = []types.OrderBookEntry{}
	}
	return &types.GetOrderBookResp{
		Code:    0,
		Message: "ok",
		Bids:    bids,
		Asks:    asks,
	}, nil
}

type pendingLevel struct {
	price  *big.Int
	amount *big.Int
}

func pendingOrdersToLevels(orders []*model.Order, limit int) (bids, asks []svc.OrderBookLevel) {
	if limit <= 0 {
		limit = 20
	}
	bidMap := make(map[string]*pendingLevel)
	askMap := make(map[string]*pendingLevel)

	for _, order := range orders {
		if order == nil {
			continue
		}
		paper, paperOK := new(big.Int).SetString(strings.TrimSpace(order.PaperAmount), 10)
		credit, creditOK := new(big.Int).SetString(strings.TrimSpace(order.CreditAmount), 10)
		if !paperOK || !creditOK || paper.Sign() == 0 || credit.Sign() == 0 {
			continue
		}
		absPaper := new(big.Int).Abs(new(big.Int).Set(paper))
		absCredit := new(big.Int).Abs(new(big.Int).Set(credit))
		filled, filledOK := new(big.Int).SetString(strings.TrimSpace(order.FilledAmount), 10)
		if !filledOK {
			filled = new(big.Int)
		}
		filled.Abs(filled)
		remain := new(big.Int).Sub(absPaper, filled)
		if remain.Sign() <= 0 {
			continue
		}

		price := new(big.Int).Mul(absCredit, new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
		price.Div(price, absPaper)
		if price.Sign() <= 0 {
			continue
		}

		levels := askMap
		if paper.Sign() > 0 {
			levels = bidMap
		}
		key := price.String()
		if level := levels[key]; level != nil {
			level.amount.Add(level.amount, remain)
		} else {
			levels[key] = &pendingLevel{
				price:  new(big.Int).Set(price),
				amount: new(big.Int).Set(remain),
			}
		}
	}

	return sortedPendingLevels(bidMap, limit, true), sortedPendingLevels(askMap, limit, false)
}

func sortedPendingLevels(levels map[string]*pendingLevel, limit int, descending bool) []svc.OrderBookLevel {
	rows := make([]*pendingLevel, 0, len(levels))
	for _, level := range levels {
		rows = append(rows, level)
	}
	sort.Slice(rows, func(i, j int) bool {
		cmp := rows[i].price.Cmp(rows[j].price)
		if descending {
			return cmp > 0
		}
		return cmp < 0
	})
	if len(rows) > limit {
		rows = rows[:limit]
	}
	out := make([]svc.OrderBookLevel, 0, len(rows))
	for _, row := range rows {
		out = append(out, svc.OrderBookLevel{
			Price:  row.price.String(),
			Amount: row.amount.String(),
		})
	}
	return out
}

func toOrderBookEntries(levels []svc.OrderBookLevel) []types.OrderBookEntry {
	out := make([]types.OrderBookEntry, 0, len(levels))
	for _, lv := range levels {
		out = append(out, types.OrderBookEntry{
			Price:  lv.Price,
			Amount: lv.Amount,
		})
	}
	return out
}
