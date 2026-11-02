# Microduck-only candidate — 2026-11-02

Research candidate, not deployed. It starts from desktop source 091d5a9bf,
whose `app.js` and `desktop-apps.js` SHA-256 values exactly matched both the
public HTTPS responses and the existing `31e20e24...` release at preparation:
`0fc4db939de870ec1bcd2d4754523a276f8fa65d1b36c62418db0ebe1e65b8bc` and
`ba0b56bb17fc006e4d5eeb1c79e674dfb9dc8e9f2cf814e1b593adc5d727a8e9`.
It carries the Microduck My files workflow and the minimum `.brf` desktop
routing/launch-allowlist changes only; no CAD or chunk-sync research is added.
Those two public-file comparisons alone do not establish that every deployed
asset or managed hosting input matches this source. Recheck the actual active
release and all relevant pins before an activation.

The experimental two-app Microduck/Files bundle has Microduck bundle hash
`3ede69f1f734793c523a300cb3fe22a8ef682db0ad77395f1f7770b856fd05dc` and
catalog SHA-256 `99ab342e3de6d5c0c13baac5e0ae8863c35abcf227592a23c561249dfc2d898f`.
It is a test catalog, not a complete live desktop release. The generated project
and visual assets matched the previously documented SHA-256 pins
`7bed18ccb5ee0da8d6939f8ce43fb4272fea35b82f357f0be4db92d28b4b63f2` and
`ee72047f7773cf2c9ae4f975db38921947bc11a4cb3ef242ed25227d6a452abd`.
The copied MuJoCo JS, WASM and declarations matched the three qualified pins in
`ENGINE-ARTIFACT-CHECKPOINT.md`. The loopback runner was built for the loopback
test origin using the retained pinned policy. These matching hashes establish
which inputs were tested; they do not independently prove their source or
license provenance. No downloaded dependencies or generated assets are Git
inputs.

The exact candidate passed real isolated account/server tests on desktop and
an emulated phone: chosen filename, server synchronization, cancel overwrite,
cancel open without losing the current runner, Files open, another-account
denial, switch project, reload/login and restore the newer path. The separate
staged-open browser suite passed at 1080p, 4K and an emulated phone viewport,
including malformed file and runner-start failure preserving the prior session,
then successful replacement and close cleanup. Physical phone behavior was
not tested. The existing close warning remains: saved experiments do not contain
the complete live plant state. The `.brf` opener remains limited to 64 MiB.

Before any rollout, review the source diff and asset inventory, preserve every
other live app/catalog entry and routing policy, use the existing controlled
publisher and managed hosting validation with a concrete rollback, and rerun
live-compatible checks of login, Files, Microduck runner and all hosted sites.
The two-app catalog must not replace the complete production catalog. This
candidate makes no deployment or live-test request by itself.

## Staged full-catalog candidate

The complete candidate `5abfd489f72fa3e18d6301890ad2fb6560ac3831351696348b8444f5527c74a5`
is staged at `/srv/codi-connected/simplified/<candidate>` but is **not active**.
The current active release remains `31e20e24c17d89fe36b3e21e170b114d4ec3df367fe31c1556661ae5fcb6439f`.
All 6,266 old and new manifest files were independently rehashed; all 74 app
records remain and the 73 non-Microduck records are unchanged. The root-only
complete old/new file report is
`/var/backups/webhost-sites/microduck-only-stage-e58wTwBO/release-diff.json`
(SHA-256 `233710bd0110a7bba34819639f6af7537fdc6a98590973465bdda5e389c2182a`).
Only `app.js`, `desktop-apps.js`, `apps.json`, the Microduck bundle and derived
cache manifest/worker change. The hard-linked release files are immutable: do
not edit, chmod or chown linked files in place.

Expected current SHA-256 pins: managed generator `15f8425440e73b316a9460b93149fa7145aad1a07c560d7cfab8d4fb841fef92`,
`sites.toml` `624efb135deb92121973961eeaf8cdc27fb03d513a06ce9b43fde548c4c29561`,
and active Caddyfile `9c267595fd90d2a7a3982987eaf204787dbbeeb44f477740560c0e89ef05b784`.
The independently rendered candidate differs only in release ID; expected new
manifest and Caddy hashes are `4641feb1447a67a3739500640426d52aca42dc2ecb8b0060989118a1bb1ac1c2`
and `89018dc280838a254a3c34e7193580aa85f27eae3d7254d3bea65ba27ad7e794`.
Caddy validation passed without activation. Root-protected pre-stage copies of
`sites.toml`, `common.py` and Caddyfile are under the same backup directory.

The reviewed-source controller wrapper is stored root-only at
`/var/backups/webhost-sites/microduck-only-stage-e58wTwBO/manage-live-only-candidate.py`
(SHA-256 `185a45a5d6eef55eb94c1ce6e082ad25e10cfe8c4658ce338b835aeede2be0c5`).
Read it before use. It requires the controller lock and checks the exact old or
new hosting pins, generator, backup/diff, active mode, release and all staged
file hashes; it uses the existing `webctl` validation/render/apply functions,
snapshots the manifest and attempts to restore the previous managed state on
failure. Independent fixture tests cover validation, rollback and injected
reload failure; a real-host `verify` passed without activation. These explicit
commands are for a separately reviewed future action, not part of staging:

```sh
sudo python3 /var/backups/webhost-sites/microduck-only-stage-e58wTwBO/manage-live-only-candidate.py verify
sudo python3 /var/backups/webhost-sites/microduck-only-stage-e58wTwBO/manage-live-only-candidate.py activate
# If the exact newly activated pins remain current and rollback is required:
sudo python3 /var/backups/webhost-sites/microduck-only-stage-e58wTwBO/manage-live-only-candidate.py rollback
```

A changed pin makes either mutation refuse; reassess rather than force it. A
reload can disconnect proxied streams. Post-activation verify the new manifest,
Caddy, cache ID and public shell hashes; test login, Microduck runner, named
save/sync, Files open, layout restore and account isolation; then compare all
ten site statuses to root-only `site-status-before.json` (SHA-256
`f6f78c90b3ed0d1be7b7cfba4a51a18536b10f65ada8d9679f51c4d770cc0c43`):
nine HTTPS 200, hardware.ksu.codes 401. Roll back if the qualified workflow or
unrelated site checks fail.

`tests/microduck-live-only-smoke.mjs` is the scoped smoke driver. It accepts only
loopback or `https://ksu.codes/`; live use requires `MICRODUCK_LIVE_SMOKE=yes`,
`MICRODUCK_REGISTER_LIVE=yes`, two unique `smoke` plus 20 lowercase hex names,
random passwords and a new absolute `MICRODUCK_SMOKE_RECEIPT` path. Supply
credentials through a private process environment, not command history. It
writes only username/subject and a post-logout quiescence time in a 0600
receipt, removes only its two named files and random folder, and never deletes
accounts. Rehearsal on loopback verified the workflow and receipt; live use has
not yet been run. After at least 90 seconds, inspect the receipt and run the
separately reviewed `tools/microduck-smoke-account-cleanup.py` dry-run against
issuer `/var/lib/codi-connected/ksu/issuer/state/accounts.sqlite3`, gateway
state `/var/lib/codi-gateway/ksu`, and data root `/var/lib/codi-user-files/ksu`.
Only if the exact receipt-bound accounts, empty homes, permissions and sessions
pass should an operator repeat with `--apply`; use `--orphans-only` solely to
retry verified empty-home cleanup after a committed database deletion. Partial
receipt, failed logout, unexpected files or changed state means preserve and
investigate. Never wipe shared account tables.

## Live activation and smoke — historical

The reviewed managed wrapper activated
`5abfd489f72fa3e18d6301890ad2fb6560ac3831351696348b8444f5527c74a5`.
A live signed-account smoke passed runner startup, named save and server sync,
cancelled overwrite/open, Files-to-Microduck open, path switch and restore after
sign-in, second-account denial, and close. Its two random test files and folder
were removed. Both test browser sessions were logged out and closed.

After the receipt-bound quiet interval, the scoped account-cleanup dry run
passed; `--apply` removed exactly the two disposable smoke accounts and their
empty homes. The orphan-only verification found no remaining homes. Test
credentials and the temporary private receipt were removed; no shared account
table or unrelated data was wiped. Public shell and managed pins matched the
activated release, and the ten site statuses matched the baseline (nine HTTP
200 and hardware.ksu.codes HTTP 401). These are live smoke results, not a claim
that full live simulation state is saved.

This record is historical: the later G-code-only release superseded this
Microduck release. Its current rollback instructions and pins are in
`evidence/gcode-live-only-candidate-20261102.md` on the G-code live-only branch.
Do not run the Microduck-era rollback command without rechecking current pins.
