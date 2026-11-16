# Historical Microduck hosting policy — inactive source

`microduck_hosting.py` preserves the unchanged app-specific runner/frame hosting
policy from the captured isolated-host source. Its source history, authorship,
Git mode and original bytes are retained. It belongs to Microduck rather than
parent deployment composition. Existing legacy backend configuration remains
separate in `legacy/backend/origin_service/`.

The source defines profile validation, document CSP and hosting snippets. It is
not registered in the app build, runtime, release or deployment entrypoints. Do
not import or activate it until current asset origins, frame policy, public host
interfaces and configuration inputs have been deliberately reviewed and ported.
Same-origin code remains trusted; CSP or Git ownership is not an app sandbox.

Syntax and bounded source screening pass; original scoped index/working bytes,
recovery and independent extracted bytes/mode match. The file restored offline
with original and assembly hidden. No old module was imported or executed. This
is mechanical source preservation, not current browser qualification, a fix for
the existing missing-fixture baseline failures, or complete publication clearance.
Private phase84 retains commands, source/commit maps and restore proof. The
parent's `migration/HOST-CONTEXT-AND-MICRODUCK-SOURCE.md` records the ownership pass.
