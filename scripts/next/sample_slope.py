#!/usr/bin/env python3
"""
Sampling script for INC-2022-08-SLOPE.
Reproducible sampling with seed 20261014.
Modes:
  --prepare : Offline calculation of victim count, t0 mapping, and shuffled SHA-256.
  --run     : On-chain verification using Helius RPC against acceptance criteria.
"""

import sys
import os
import csv
import json
import random
import hashlib
import time
from datetime import datetime, timezone
import urllib.request
import urllib.error

SEED = 20261014
EXPECTED_VICTIM_COUNT = 1326
MAX_CANDIDATES = 150
MAX_ACCEPTED = 5
MAX_RPC_CALLS = 600

ATTACKER_WALLETS = {
    "GeEccGJ9BEzVbVor1njkBCCiqXJbXVeDHaXDCrBDbmuy",
    "5WwBYgQG6BdErM2nNNyUmQXfcUnB68b6kesxBywh1J3n",
    "CEzN7mqP9xoxn2HdyW6fjEJ73t7qaX9Rp2zyS6hb3iEu",
    "Htp9MGP8Tig923ZFY7Qf2zzbMUmYneFRAhSp7vSg4wxV"
}

WINDOW_START_UNIX = 1659479820  # 2022-08-02T22:37:00Z
WINDOW_END_UNIX   = 1659754800  # 2022-08-06T03:00:00Z

DATA_DIR = r"C:\Users\cbell\Documents\antigravity\analysis-data\slope"
VICTIMS_CSV = os.path.join(DATA_DIR, "Slope Sentry Victim - Stolen Transaction - Sheet1.csv")
HACKER_CSV = os.path.join(DATA_DIR, "_Hacker's wallet - Solana Merge Transaction - Sheet1.csv")

def get_helius_key():
    key = os.environ.get("HELIUS_API_KEY")
    if key:
        return key.strip("'\" ")
    # Search standard paths
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "kind-darwin", "radar.env"),
        os.path.join(os.path.dirname(__file__), "..", "..", "radar.env"),
        r"C:\Users\cbell\Documents\antigravity\kind-darwin\radar.env"
    ]
    for p in candidates:
        ap = os.path.abspath(p)
        if os.path.exists(ap):
            try:
                with open(ap, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("HELIUS_API_KEY="):
                            return line.split("=", 1)[1].strip("'\" ")
            except Exception:
                pass
    return None

def load_data():
    if not os.path.exists(VICTIMS_CSV):
        raise FileNotFoundError(f"Victims CSV not found: {VICTIMS_CSV}")
    if not os.path.exists(HACKER_CSV):
        raise FileNotFoundError(f"Hacker CSV not found: {HACKER_CSV}")

    # 1. Read hacker transactions mapping: Txhash -> BlockTime Unix
    hacker_txs = {}
    with open(HACKER_CSV, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            tx = row.get("Txhash", "").strip()
            bt_unix = row.get("BlockTime Unix", "").strip()
            if tx and bt_unix:
                try:
                    hacker_txs[tx] = int(bt_unix)
                except ValueError:
                    pass

    # 2. Read Solana victims and their signatures
    victim_signatures = {}
    with open(VICTIMS_CSV, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            chain = row.get("Chain", "").strip()
            if chain == "Solana":
                v_addr = row.get("Victim Address", "").strip()
                tx = row.get("Tx Hash", "").strip()
                if v_addr:
                    if v_addr not in victim_signatures:
                        victim_signatures[v_addr] = set()
                    if tx:
                        victim_signatures[v_addr].add(tx)

    # 3. For each victim, compute t0: minimum BlockTime Unix across its signatures.
    # Tie-breaker: lexicographically smaller signature.
    victim_t0 = {}
    for v_addr, sigs in victim_signatures.items():
        candidates = []
        for s in sigs:
            if s in hacker_txs:
                candidates.append((hacker_txs[s], s))
        if candidates:
            # Sort by unix timestamp ascending, then signature string ascending
            candidates.sort(key=lambda x: (x[0], x[1]))
            best_unix, best_sig = candidates[0]
            victim_t0[v_addr] = {
                "t0_unix": best_unix,
                "t0_signature": best_sig
            }
        else:
            raise ValueError(f"No hacker journal timestamp found for victim: {v_addr}")

    # Lexicographically sorted list of unique victim addresses
    sorted_victims = sorted(list(victim_signatures.keys()))

    # Shuffle with seed
    rng = random.Random(SEED)
    shuffled_victims = list(sorted_victims)
    rng.shuffle(shuffled_victims)

    shuffled_str = "\n".join(shuffled_victims)
    list_sha256 = hashlib.sha256(shuffled_str.encode("utf-8")).hexdigest()

    return {
        "shuffled_victims": shuffled_victims,
        "list_sha256": list_sha256,
        "victim_t0": victim_t0,
        "total_victims": len(shuffled_victims)
    }

class HeliusRPC:
    def __init__(self, api_key):
        self.url = f"https://mainnet.helius-rpc.com/?api-key={api_key}"
        self.call_count = 0

    def _rpc_call(self, method, params):
        if self.call_count >= MAX_RPC_CALLS:
            raise RuntimeError(f"Helius RPC call budget ({MAX_RPC_CALLS}) reached!")

        payload = {
            "jsonrpc": "2.0",
            "id": self.call_count + 1,
            "method": method,
            "params": params
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.url,
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "SlopeSampler/1.0"}
        )

        for attempt in range(5):
            self.call_count += 1
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    resp_data = resp.read()
                    res = json.loads(resp_data.decode("utf-8"))
                    if "error" in res:
                        raise RuntimeError(f"RPC Error: {res['error']}")
                    return res.get("result")
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait_time = 2 ** attempt + 1
                    time.sleep(wait_time)
                    continue
                raise
            except Exception as e:
                if attempt == 4:
                    raise
                time.sleep(2)
        raise RuntimeError("RPC request failed after 5 retries")

    def get_transaction(self, signature):
        params = [
            signature,
            {
                "encoding": "jsonParsed",
                "maxSupportedTransactionVersion": 0
            }
        ]
        return self._rpc_call("getTransaction", params)

    def get_signatures_for_address(self, address, before_sig, limit=100):
        params = [
            address,
            {
                "before": before_sig,
                "limit": limit
            }
        ]
        return self._rpc_call("getSignaturesForAddress", params)

def check_candidate(rpc, victim_addr, t0_info):
    sig = t0_info["t0_signature"]
    journal_unix = t0_info["t0_unix"]

    # 1. Fetch transaction
    tx = rpc.get_transaction(sig)
    if not tx:
        return False, "transaction_not_found", 0

    meta = tx.get("meta")
    if not meta:
        return False, "missing_meta", 0

    # Criterion (a): err == null
    if meta.get("err") is not None:
        return False, f"transaction_err_not_null: {meta.get('err')}", 0

    # Criterion (a): blockTime checks
    block_time = tx.get("blockTime")
    if block_time is None:
        return False, "missing_blockTime", 0

    if abs(block_time - journal_unix) > 2:
        return False, f"blockTime_mismatch (onchain={block_time}, journal={journal_unix})", 0

    if not (WINDOW_START_UNIX <= block_time <= WINDOW_END_UNIX):
        return False, f"blockTime_out_of_window ({block_time})", 0

    # Criterion (b): victim is a signer of the transaction
    # Extract signers from transaction message
    transaction = tx.get("transaction", {})
    message = transaction.get("message", {})
    account_keys = message.get("accountKeys", [])

    signers = set()
    for acc in account_keys:
        if isinstance(acc, dict):
            if acc.get("signer") is True:
                signers.add(acc.get("pubkey"))
        elif isinstance(acc, str):
            # In raw json, first header['numRequiredSignatures'] keys are signers
            pass
    if not signers and isinstance(account_keys, list) and account_keys and isinstance(account_keys[0], str):
        num_req = message.get("header", {}).get("numRequiredSignatures", 0)
        signers = set(account_keys[:num_req])

    if victim_addr not in signers:
        return False, "victim_not_signer", 0

    # Criterion (c): recipient in ATTACKER_WALLETS (SOL transfer) or token balance owner in ATTACKER_WALLETS
    sol_transfer_to_attacker = False
    # Check balance changes for attacker wallets in accountKeys
    pre_balances = meta.get("preBalances", [])
    post_balances = meta.get("postBalances", [])
    for idx, acc in enumerate(account_keys):
        pk = acc.get("pubkey") if isinstance(acc, dict) else acc
        if pk in ATTACKER_WALLETS:
            if idx < len(pre_balances) and idx < len(post_balances):
                if post_balances[idx] > pre_balances[idx]:
                    sol_transfer_to_attacker = True
                    break

    token_transfer_to_attacker = False
    post_token_balances = meta.get("postTokenBalances", [])
    for tb in post_token_balances:
        owner = tb.get("owner")
        if owner in ATTACKER_WALLETS:
            token_transfer_to_attacker = True
            break

    if not (sol_transfer_to_attacker or token_transfer_to_attacker):
        return False, "no_transfer_to_attacker_wallets", 0

    # Criterion (d): before t0, victim has >= 20 successful transactions (limit 100)
    time.sleep(0.1) # Small pause
    prior_sigs = rpc.get_signatures_for_address(victim_addr, sig, limit=100)
    if prior_sigs is None:
        return False, "failed_fetching_prior_signatures", 0

    successful_prior = [s for s in prior_sigs if s.get("err") is None]
    baseline_count = len(successful_prior)

    if baseline_count < 20:
        return False, f"insufficient_baseline_txs ({baseline_count} < 20)", baseline_count

    return True, "accepted", baseline_count

def prepare_mode():
    data = load_data()
    print("=== PREPARE MODE ===")
    print(f"Total Solana victims: {data['total_victims']}")
    print(f"SHA256 of shuffled list: {data['list_sha256']}")
    print("Printed 0 addresses (addresses kept out of output and git).")
    return data

def run_mode():
    data = load_data()
    shuffled_victims = data["shuffled_victims"]
    list_sha256 = data["list_sha256"]
    victim_t0 = data["victim_t0"]

    # Verify sha256 against SAMPLING-INC-2022-08-SLOPE.md
    doc_path = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "next", "cases", "SAMPLING-INC-2022-08-SLOPE.md")
    if not os.path.exists(doc_path):
        raise FileNotFoundError(f"Sampling doc not found: {doc_path}")

    with open(doc_path, "r", encoding="utf-8") as f:
        doc_text = f.read()

    if list_sha256 not in doc_text:
        raise ValueError(f"SHA256 mismatch! Computed {list_sha256} not found in {doc_path}")

    print("Reproduced shuffled list successfully. SHA256 verified against document.")

    api_key = get_helius_key()
    if not api_key:
        raise RuntimeError("HELIUS_API_KEY not found in environment or radar.env!")

    rpc = HeliusRPC(api_key)

    log_entries = []
    accepted_candidates = []
    rejection_reasons = {}

    print(f"Starting candidate checks (stop at {MAX_ACCEPTED} accepted or {MAX_CANDIDATES} checked)...")

    for idx, victim_addr in enumerate(shuffled_victims[:MAX_CANDIDATES]):
        if len(accepted_candidates) >= MAX_ACCEPTED:
            break
        if rpc.call_count >= MAX_RPC_CALLS:
            print(f"Stopping: reached maximum RPC calls ({MAX_RPC_CALLS}).")
            break

        pos = idx + 1
        t0_info = victim_t0[victim_addr]

        try:
            ok, reason, baseline_count = check_candidate(rpc, victim_addr, t0_info)
        except Exception as e:
            ok = False
            reason = f"error: {type(e).__name__}"
            baseline_count = 0

        time.sleep(0.1)

        if ok:
            # Format UTC timestamp
            dt_utc = datetime.fromtimestamp(t0_info["t0_unix"], tz=timezone.utc)
            iso_utc = dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
            cand_info = {
                "position": pos,
                "wallet": victim_addr,
                "t0_signature": t0_info["t0_signature"],
                "t0_utc": iso_utc,
                "baseline_count": baseline_count
            }
            accepted_candidates.append(cand_info)
            log_entries.append({
                "position": pos,
                "status": "ACCEPTED",
                "reason": f"meets all criteria; baseline_txs={baseline_count}",
                "rpc_calls_so_far": rpc.call_count
            })
            print(f"Position {pos}: ACCEPTED (baseline_txs={baseline_count}, RPC calls={rpc.call_count})")
        else:
            base_reason = reason.split(":")[0].split(" (")[0]
            rejection_reasons[base_reason] = rejection_reasons.get(base_reason, 0) + 1
            log_entries.append({
                "position": pos,
                "status": "REJECTED",
                "reason": reason,
                "rpc_calls_so_far": rpc.call_count
            })
            print(f"Position {pos}: REJECTED - {reason} (RPC calls={rpc.call_count})")

    # Write log file: docs/next/cases/sampling-INC-2022-08-SLOPE-log.md
    log_path = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "next", "cases", "sampling-INC-2022-08-SLOPE-log.md")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write("# Sampling Verification Log: INC-2022-08-SLOPE\n\n")
        f.write(f"- Timestamp (UTC): {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}\n")
        f.write(f"- Seed: {SEED}\n")
        f.write(f"- Shuffled list SHA-256: `{list_sha256}`\n")
        f.write(f"- Candidates checked: {len(log_entries)}\n")
        f.write(f"- Candidates accepted: {len(accepted_candidates)} (target: {MAX_ACCEPTED})\n")
        f.write(f"- Total Helius RPC calls: {rpc.call_count}\n")
        f.write("- Rejection breakdown:\n")
        for r, cnt in sorted(rejection_reasons.items(), key=lambda x: -x[1]):
            f.write(f"  - `{r}`: {cnt}\n")
        f.write("\n## Note on Privacy & Method Integrity\n")
        f.write("Candidate addresses that were rejected are NOT published or logged here (only candidate position index and technical reason).\n")
        f.write("The previous row C-001 in cases.csv (news pointer placeholder) has been replaced by the sampled on-chain cases.\n\n")
        f.write("## Candidate Check Steps\n\n")
        f.write("| Position | Status | Reason / Details | Total RPC Calls |\n")
        f.write("|:---------|:-------|:-----------------|:----------------|\n")
        for entry in log_entries:
            f.write(f"| {entry['position']} | {entry['status']} | {entry['reason']} | {entry['rpc_calls_so_far']} |\n")

    # Update cases.csv
    cases_path = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "next", "cases", "cases.csv")
    with open(cases_path, "r", encoding="utf-8") as f:
        existing_rows = list(csv.reader(f))

    header = existing_rows[0]
    # Retain non-C-001 rows
    other_rows = [r for r in existing_rows[1:] if r and r[0] != "C-001"]

    recorded_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    new_rows = []
    for i, cand in enumerate(accepted_candidates):
        cid = f"C-001-{i+1}"
        row = [
            cid,                                                                                   # case_id
            "INC-2022-08-SLOPE",                                                                  # incident_id
            "1326 (documented victims in the used list; about 9231 per Solana Foundation)",        # cluster_size
            "A1",                                                                                  # event_type
            cand["wallet"],                                                                        # wallet
            cand["t0_signature"],                                                                  # t0_signature
            cand["t0_utc"],                                                                        # t0_utc
            "https://solana.com/news/8-2-2022-application-wallet-incident; https://slowmist.medium.com/analysis-of-a-large-scale-attack-on-solana-part-2-ee105d907c12", # source_url
            "Slope Wallet Incident Update; Analysis of a Large-scale Attack on Solana (Part 2)",   # source_title
            "2022-08-02",                                                                          # source_date
            "foundation incident update; security-firm analysis",                                  # source_type
            "yes",                                                                                 # independent_source
            "wallet owners",                                                                       # harmed_party
            "about 4.1 million (Solana Foundation, as stated)",                                    # reported_loss_usd_as_stated
            str(cand["baseline_count"]),                                                           # baseline_txs_before_t0
            "unknown",                                                                             # pre_signal_expected
            "accepted",                                                                            # status
            "",                                                                                    # reject_reason
            "author",                                                                              # recorded_by
            recorded_at                                                                            # recorded_at_utc
        ]
        new_rows.append(row)

    all_rows = [header] + new_rows + other_rows
    with open(cases_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(all_rows)

    print("\n=== SUMMARY OF RUN ===")
    print(f"Candidates checked: {len(log_entries)}")
    print(f"Accepted: {len(accepted_candidates)}")
    print(f"Rejections: {rejection_reasons}")
    print(f"Total RPC calls: {rpc.call_count}")
    print(f"Cases updated in: {cases_path}")
    print(f"Log written to: {log_path}")

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--prepare":
        prepare_mode()
    elif len(sys.argv) > 1 and sys.argv[1] == "--run":
        run_mode()
    else:
        print("Usage: python sample_slope.py [--prepare | --run]")
        sys.exit(1)
