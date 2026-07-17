# TxLINE API — builder feedback

*Requested in the submission form. Honest notes from building CalledIt.*

## What we loved

1. **The possession-phase taxonomy is a consumer goldmine.** `safe_possession →
   attack_possession → danger_possession → high_danger_possession → possible`
   is exactly the emotional arc of watching football. We turned it directly
   into a momentum meter and moment-card triggers. No other feed we know
   exposes "danger" as a first-class stream in real time.
2. **One normalised JSON schema, really.** The same code path ingested the live
   SSE stream and the historical endpoint byte-for-byte. Our replay mode is
   the live engine pointed at captured data — zero adaptation.
3. **Amendment semantics are honest.** Goals arrive fast, then get amended
   (scorer id), and can be discarded after VAR (`var_end` → `action_discarded`,
   with the `Score` object self-correcting). Once we understood the pattern it
   let us build "instant celebration, VAR-safe settlement" — which *feels*
   right to a fan.
4. **StablePrice with `Pct` implied probabilities** saved us from de-margining
   odds ourselves; prices in integer thousandths avoid float mess.
5. **Free tier + guest JWT** meant the first data hit took minutes. Historical
   replay of finished fixtures (6h–2w window) is a superb hackathon feature.

## Friction we hit

1. **The historical scores endpoint returns SSE framing** (`data:` blocks) with
   `Content-Type` that json parsers reject. Documenting this (or offering
   `?format=json`) would save every team an hour.
2. **`/api/odds/updates/{epochDay}/{hourOfDay}/{interval}` semantics are
   undocumented** — we had to discover empirically that `interval` is a 10-minute
   slot (0–5). A one-line doc fix.
3. **Half-time markets share the stream with full-time ones**, distinguished
   only by `MarketParameters`/`MarketPeriod` (`half=1`). Our win-prob bar
   oscillated wildly until we filtered. Worth a doc callout with the enum of
   `MarketPeriod` values.
4. **Odds snapshot for finished fixtures returns `[]`**, so replay pricing must
   come from the time-window endpoint. Fine once known, surprising at first.
5. **Devnet is missing the SPL Memo v2 program** (`MemoSq4g…`); Memo v1
   (`Memo1Uh…`) works. Not TxLINE's fault, but a note in the devnet docs would
   help teams anchoring app-level data next to TxLINE's.
6. Minor: `GameState` appears both as int (fixtures) and string (score events);
   `Participant1IsHome` on neutral venues is documented, appreciated.

## Wishlist

- A `possible`-style pre-event signal for **set pieces** (free kick in range →
  shot) would enable even sharper moment cards.
- Player-name resolution endpoint (id → name) — we currently mine `Lineups`.
- WebSocket option next to SSE for browsers (we proxy through our server).
