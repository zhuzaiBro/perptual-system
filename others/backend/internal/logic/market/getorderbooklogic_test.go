package market

import (
	"testing"

	"metanode/internal/model"
)

func TestPendingOrdersToLevelsAggregatesRemainingAndSorts(t *testing.T) {
	orders := []*model.Order{
		{
			PaperAmount:  "100000000000000000",
			CreditAmount: "-200000000",
			FilledAmount: "0",
		},
		{
			PaperAmount:  "200000000000000000",
			CreditAmount: "-400000000",
			FilledAmount: "50000000000000000",
		},
		{
			PaperAmount:  "100000000000000000",
			CreditAmount: "-199000000",
			FilledAmount: "0",
		},
		{
			PaperAmount:  "-100000000000000000",
			CreditAmount: "201000000",
			FilledAmount: "0",
		},
		{
			PaperAmount:  "-200000000000000000",
			CreditAmount: "404000000",
			FilledAmount: "50000000000000000",
		},
	}

	bids, asks := pendingOrdersToLevels(orders, 20)
	if len(bids) != 2 {
		t.Fatalf("bids len=%d want=2", len(bids))
	}
	if bids[0].Price != "2000000000" || bids[0].Amount != "250000000000000000" {
		t.Fatalf("best bid=%+v", bids[0])
	}
	if bids[1].Price != "1990000000" {
		t.Fatalf("second bid=%+v", bids[1])
	}
	if len(asks) != 2 {
		t.Fatalf("asks len=%d want=2", len(asks))
	}
	if asks[0].Price != "2010000000" || asks[0].Amount != "100000000000000000" {
		t.Fatalf("best ask=%+v", asks[0])
	}
	if asks[1].Price != "2020000000" || asks[1].Amount != "150000000000000000" {
		t.Fatalf("second ask=%+v", asks[1])
	}
}

func TestPendingOrdersToLevelsRespectsLimitAndSkipsFilled(t *testing.T) {
	orders := []*model.Order{
		{
			PaperAmount:  "100000000000000000",
			CreditAmount: "-200000000",
			FilledAmount: "100000000000000000",
		},
		{
			PaperAmount:  "100000000000000000",
			CreditAmount: "-201000000",
			FilledAmount: "0",
		},
		{
			PaperAmount:  "100000000000000000",
			CreditAmount: "-199000000",
			FilledAmount: "0",
		},
	}

	bids, asks := pendingOrdersToLevels(orders, 1)
	if len(bids) != 1 || bids[0].Price != "2010000000" {
		t.Fatalf("bids=%+v", bids)
	}
	if len(asks) != 0 {
		t.Fatalf("asks=%+v", asks)
	}
}
