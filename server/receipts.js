'use strict';
/**
 * Anchors Called-It receipts to Solana devnet.
 *
 * Every winning call produces a receipt whose sha256 hash goes into a batch.
 * Each batch is committed as a single Memo transaction:
 *    "CALLEDIT v1 root=<sha256 of concatenated receipt hashes> n=<count>"
 * The tx signature + slot are stored back on every receipt in the batch, so
 * anyone can recompute the receipt hash -> batch root -> on-chain memo.
 */
const fs = require('fs');
const crypto = require('crypto');

let web3 = null;
try { web3 = require('@solana/web3.js'); } catch { /* optional */ }

// Memo v1 — deployed on devnet (v2 MemoSq4g… is absent there)
const MEMO_PROGRAM = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

class ReceiptAnchor {
  constructor({ rpc, cluster, secret, keypairPath, batchMs }, log = console) {
    this.log = log;
    this.cluster = cluster;
    this.queue = [];
    this.enabled = false;
    this.pubkey = null;
    if (!web3) { log.warn('[anchor] @solana/web3.js unavailable — anchoring disabled'); return; }
    try {
      let secretArr = null;
      if (secret) secretArr = JSON.parse(secret);
      else if (keypairPath && fs.existsSync(keypairPath)) secretArr = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
      if (!secretArr) { log.warn('[anchor] no keypair configured — anchoring disabled'); return; }
      this.keypair = web3.Keypair.fromSecretKey(Uint8Array.from(secretArr));
      this.pubkey = this.keypair.publicKey.toBase58();
      this.conn = new web3.Connection(rpc, 'confirmed');
      this.enabled = true;
      this.timer = setInterval(() => this.flush().catch(e => log.warn('[anchor] flush:', e.message)), batchMs);
      if (this.timer.unref) this.timer.unref();
      log.log(`[anchor] enabled, wallet ${this.pubkey}`);
    } catch (e) {
      log.warn('[anchor] init failed:', e.message);
    }
  }

  push(receipt) {
    if (!this.enabled) return;
    this.queue.push(receipt);
  }

  async flush() {
    if (!this.enabled || this.queue.length === 0 || this.inflight) return;
    const batch = this.queue.splice(0, 24);
    this.inflight = true;
    try {
      const root = crypto.createHash('sha256').update(batch.map(r => r.hash).join('')).digest('hex');
      const memo = `CALLEDIT v1 root=${root} n=${batch.length}`;
      const ix = new web3.TransactionInstruction({
        keys: [],
        programId: new web3.PublicKey(MEMO_PROGRAM),
        data: Buffer.from(memo, 'utf8'),
      });
      const tx = new web3.Transaction().add(ix);
      const sig = await web3.sendAndConfirmTransaction(this.conn, tx, [this.keypair], { commitment: 'confirmed' });
      const slot = (await this.conn.getSignatureStatus(sig))?.value?.slot || null;
      const anchor = {
        txSig: sig, slot, root, memo,
        batch: batch.map(r => r.hash),
        explorer: `https://explorer.solana.com/tx/${sig}?cluster=${this.cluster}`,
        anchoredAt: Date.now(),
      };
      for (const r of batch) r.anchor = anchor;
      this.log.log(`[anchor] committed ${batch.length} receipt(s): ${sig}`);
      this.onAnchored && this.onAnchored(batch);
    } catch (e) {
      this.log.warn('[anchor] tx failed, requeueing:', e.message);
      this.queue.unshift(...batch);
    } finally {
      this.inflight = false;
    }
  }

  /** Independently recompute the verification chain for a receipt. */
  static verify(receipt) {
    const recomputedHash = crypto.createHash('sha256').update(JSON.stringify(receipt.body)).digest('hex');
    const hashOk = recomputedHash === receipt.hash;
    let rootOk = null;
    if (receipt.anchor) {
      const root = crypto.createHash('sha256').update(receipt.anchor.batch.join('')).digest('hex');
      rootOk = root === receipt.anchor.root && receipt.anchor.batch.includes(receipt.hash);
    }
    return { hashOk, rootOk, recomputedHash };
  }
}

module.exports = { ReceiptAnchor };
