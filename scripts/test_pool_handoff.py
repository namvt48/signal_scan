"""Regression settlement pool→pool; chạy python3 -m unittest scripts.test_pool_handoff -v."""

import contextlib
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from watchers.common import config, price
from watchers.common.emit import watch_trade_body
from watchers.sol import classify, feed

FIXTURE = Path(__file__).parent / "fixtures" / "regress" / "3sZuVGPm.json"
WALLET = "Wallet"
TOKEN = "TokenFinal"
PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"


def settlement_tx(
    *,
    sell=False,
    separate_frame=False,
    quote_owner="Settlement",
    fee=False,
    program=PUMP,
    wallet=WALLET,
    token=TOKEN,
):
    owners = {
        "upstream_quote": "Upstream",
        "settlement_quote": quote_owner,
        "settlement_token": "Settlement",
        "wallet_token": wallet,
        "fee_quote": "FeeCollector",
    }
    mints = {a: token if a.endswith("token") else config.USDC for a in owners}
    legs = [
        ("upstream_quote", "settlement_quote", 10_000_000),
        ("settlement_token", "wallet_token", 5_000_000),
    ]
    if sell:
        legs = [(dst, src, amount) for src, dst, amount in legs]
    if fee:
        legs.append(("settlement_quote", "fee_quote", 100_000))
    keys = [wallet, *owners]
    delta = {a: 0 for a in owners}
    instructions = []
    for src, dst, amount in legs:
        delta[src] -= amount
        delta[dst] += amount
        instructions.append({
            "programId": SPL,
            "stackHeight": 2,
            "parsed": {"type": "transferChecked", "info": {
                "source": src, "destination": dst, "mint": mints[src],
                "tokenAmount": {"amount": str(amount), "decimals": 6},
            }},
        })
    balances = {}
    for name, after in (("preTokenBalances", False), ("postTokenBalances", True)):
        balances[name] = [{
            "accountIndex": keys.index(a), "owner": owner, "mint": mints[a],
            "uiTokenAmount": {"amount": str(20_000_000 + (delta[a] if after else 0)),
                              "decimals": 6,
                              "uiAmountString": str(20 + (delta[a] / 1_000_000 if after else 0))},
        } for a, owner in owners.items()]
    groups = [{"index": 0, "instructions": instructions}]
    top = [{"programId": program, "stackHeight": 1}]
    if separate_frame:
        groups = [{"index": 0, "instructions": instructions[:1]},
                  {"index": 1, "instructions": instructions[1:]}]
        top = top * 2
    return {
        "blockTime": 1792985815, "slot": 461513885,
        "transaction": {"signatures": ["SettlementSignature"], "message": {
            "accountKeys": [{"pubkey": a, "signer": a == wallet} for a in keys],
            "instructions": top,
        }},
        "meta": {"err": None, "innerInstructions": groups, **balances},
    }


class PoolHandoffTests(unittest.TestCase):
    def test_buy_settled_directly_from_another_pool(self):
        events = classify.detect_events(settlement_tx(), WALLET)
        buys = [e for e in events if e["mint"] == TOKEN and e["side"] == "BUY"]
        self.assertEqual(len(buys), 1)
        self.assertEqual((buys[0]["qty"], buys[0]["quote_qty"], buys[0]["quote_usd"]),
                         (5, 10, 10))
        self.assertEqual(buys[0]["pool"], "Settlement")

    def test_sell_settled_directly_to_another_pool(self):
        events = classify.detect_events(settlement_tx(sell=True), WALLET)
        sells = [e for e in events if e["mint"] == TOKEN and e["side"] == "SELL"]
        self.assertEqual(len(sells), 1)
        self.assertEqual((sells[0]["qty"], sells[0]["quote_qty"], sells[0]["quote_usd"]),
                         (5, 10, 10))

    def test_different_invocation_or_pool_does_not_turn_receive_into_buy(self):
        cases = ({"separate_frame": True}, {"quote_owner": "Unrelated"},
                 {"quote_owner": "Upstream"}, {"quote_owner": None})
        for options in cases:
            with self.subTest(options=options):
                events = classify.detect_events(settlement_tx(**options), WALLET)
                received = [e for e in events if e["mint"] == TOKEN]
                self.assertEqual([(e["type"], e["side"]) for e in received],
                                 [("TRANSFER", "transfer")])

    def test_same_direction_pool_fee_is_not_a_swap_leg(self):
        tx = settlement_tx(fee=True)
        legs = classify._legs_with_roles(tx, WALLET)
        self.assertFalse(any(e["dst"] == "fee_quote" for e in legs))
        buys = [e for e in classify.detect_events(tx, WALLET) if e["side"] == "BUY"]
        self.assertEqual([(e["mint"], e["quote_qty"]) for e in buys], [(TOKEN, 10)])

    def test_ambiguous_pool_handoff_is_rejected(self):
        tx = settlement_tx()
        msg, meta = tx["transaction"]["message"], tx["meta"]
        keys = msg["accountKeys"]
        keys.extend(
            {"pubkey": address, "signer": False}
            for address in ("upstream_quote_2", "settlement_quote_2")
        )
        for key, amount in (("preTokenBalances", "0"), ("postTokenBalances", "1000000")):
            meta[key].extend(
                [
                    {
                        "accountIndex": len(keys) - 2,
                        "owner": "Upstream_2",
                        "mint": "SecondQuote",
                        "uiTokenAmount": {"amount": amount, "decimals": 6},
                    },
                    {
                        "accountIndex": len(keys) - 1,
                        "owner": "Settlement",
                        "mint": "SecondQuote",
                        "uiTokenAmount": {"amount": amount, "decimals": 6},
                    },
                ]
            )
        meta["innerInstructions"][0]["instructions"].append(
            {
                "programId": SPL,
                "stackHeight": 2,
                "parsed": {
                    "type": "transferChecked",
                    "info": {
                        "source": "upstream_quote_2",
                        "destination": "settlement_quote_2",
                        "mint": "SecondQuote",
                        "tokenAmount": {"amount": "1000000", "decimals": 6},
                    },
                },
            }
        )
        legs = classify._legs_with_roles(tx, WALLET)
        self.assertFalse(any(e["src"] == "upstream_quote" for e in legs))
        self.assertFalse(any(e["src"] == "upstream_quote_2" for e in legs))

    def test_internal_pool_movement_is_not_a_swap_payment(self):
        for sell in (False, True):
            with self.subTest(sell=sell):
                tx = settlement_tx(sell=sell)
                keys = tx["transaction"]["message"]["accountKeys"]
                upstream = next(i for i, key in enumerate(keys)
                                if key["pubkey"] == "upstream_quote")
                for name in ("preTokenBalances", "postTokenBalances"):
                    for row in tx["meta"][name]:
                        if row["accountIndex"] == upstream:
                            row["owner"] = "Settlement"
                events = classify.detect_events(tx, WALLET)
                self.assertEqual(
                    [(e["type"], e["side"]) for e in events if e["mint"] == TOKEN],
                    [("TRANSFER", "transfer")],
                )

    def test_other_program_handoff_is_not_assumed_without_fixture_evidence(self):
        events = classify.detect_events(settlement_tx(program="OtherSwapProgram"), WALLET)
        self.assertEqual(
            [(e["type"], e["side"]) for e in events if e["mint"] == TOKEN],
            [("TRANSFER", "transfer")],
        )

    def test_same_route_recognizes_other_wallet_and_ca(self):
        wallet, token = "OtherWallet", "OtherToken"
        events = classify.detect_events(
            settlement_tx(wallet=wallet, token=token), wallet
        )
        buys = [event for event in events if event["mint"] == token]
        self.assertEqual(
            [(event["type"], event["side"], event["qty"], event["quote_qty"])
             for event in buys],
            [("SWAP", "BUY", 5, 10)],
        )

    def test_readonly_account_is_not_attributed_another_traders_buy(self):
        tx = json.loads((FIXTURE.parent / "2CFjM3fd.json").read_text())
        wallet = "CE44oKS3wpUerx8afyeii56u5oQjBLZknzm4Q2CYHUz9"
        self.assertEqual(classify.detect_events(tx, wallet), [])
        unchanged = json.loads((FIXTURE.parent / "2CFjM3fd.json").read_text())
        keys = unchanged["transaction"]["message"]["accountKeys"]
        account_index = len(keys)
        keys.append({"pubkey": "unchanged-token-account", "signer": False})
        for balances in ("preTokenBalances", "postTokenBalances"):
            unchanged["meta"][balances].append({
                "accountIndex": account_index,
                "mint": "ExistingMint",
                "owner": wallet,
                "uiTokenAmount": {"amount": "1000000", "decimals": 6, "uiAmountString": "1"},
            })
        self.assertEqual(classify.detect_events(unchanged, wallet), [])
        unrelated = json.loads((FIXTURE.parent / "2CFjM3fd.json").read_text())
        keys = unrelated["transaction"]["message"]["accountKeys"]
        account_index = len(keys)
        keys.append({"pubkey": "unrelated-token-account", "signer": False})
        for balances, amount in (("preTokenBalances", "1000000"), ("postTokenBalances", "2000000")):
            unrelated["meta"][balances].append({
                "accountIndex": account_index,
                "mint": "OtherMint",
                "owner": wallet,
                "uiTokenAmount": {"amount": amount, "decimals": 6, "uiAmountString": str(int(amount) / 1_000_000)},
            })
        detected = classify.detect_events(unrelated, wallet)
        self.assertNotIn("AhBidGAgv6QbKSWfrSCegGrzFLcBx4E5FNYTKHNQQj6C", [event["mint"] for event in detected])
        with patch.object(feed, "_warm_prices"), patch.object(feed, "jl_write"), \
                patch.object(config, "_cfg_next", 0), patch.object(feed, "_emitted", set()), \
                patch.object(config, "_tracking_since_ms", tx["blockTime"] * 1000), \
                patch.object(feed, "watch_trade_event") as trade, \
                contextlib.redirect_stdout(io.StringIO()):
            feed._handle_tx(tx, tx["transaction"]["signatures"][0], [wallet], {"wallets": {}})
        trade.assert_not_called()

    def test_non_signer_token_owner_still_receives_settled_buy(self):
        tx = settlement_tx()
        tx["transaction"]["message"]["accountKeys"][0]["signer"] = False
        events = classify.detect_events(tx, WALLET)
        self.assertEqual(
            [(e["mint"], e["side"], e["qty_net"]) for e in events],
            [(TOKEN, "BUY", 5)],
        )

    def test_actual_trader_keeps_final_token_buy_in_readonly_account_fixture(self):
        tx = json.loads((FIXTURE.parent / "2CFjM3fd.json").read_text())
        wallet = "HDPuoBPaxNAzHrPnvcKsjTpttecYT2RoMyck2kXsqWg4"
        events = feed._aggregate_watch_hops(classify.detect_events(tx, wallet))
        self.assertEqual(
            [(e["mint"], e["side"], e["qty"]) for e in events],
            [("Nwjeu8QowWv2VpQF8uDus2yUvWgDs2dTnfvuKNYSLEa", "BUY", 77979.206471)],
        )

    def test_real_pump_route_emits_final_ca_buy_once(self):
        tx = json.loads(FIXTURE.read_text())
        wallet = "5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij"
        ca = "7RTDnu4ptwdH613su7mhTYDGF4MJhZBDhjJLQ7iVpump"
        trade_bodies = []
        with patch.object(feed, "_warm_prices"), patch.object(feed, "jl_write"), \
                patch.object(config, "_cfg_next", 0), patch.object(feed, "_emitted", set()), \
                patch.object(config, "_tracking_since_ms", tx["blockTime"] * 1000), \
                patch.object(price, "_info", {}), patch.object(classify, "_info", {}), \
                patch.object(feed, "watch_trade_event", side_effect=lambda e, t: trade_bodies.append(watch_trade_body(e, t))), \
                contextlib.redirect_stdout(io.StringIO()):
            feed._handle_tx(tx, tx["transaction"]["signatures"][0], [wallet], {"wallets": {}})
            feed._handle_tx(tx, tx["transaction"]["signatures"][0], [wallet], {"wallets": {}})
        self.assertEqual([(b["ca"], b["side"], b["ts"]) for b in trade_bodies],
                         [(ca, "buy", tx["blockTime"] * 1000)])
        buys = [e for e in classify.detect_events(tx, wallet) if e["mint"] == ca]
        self.assertEqual(len(buys), 1)
        self.assertEqual((buys[0]["side"], buys[0]["type"]), ("BUY", "SWAP"))
        self.assertAlmostEqual(buys[0]["qty"], 29_858_582.37688, places=6)
        self.assertEqual(buys[0]["quote_qty"], 46_352.905816)


if __name__ == "__main__":
    unittest.main()
