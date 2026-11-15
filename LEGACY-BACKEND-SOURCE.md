# Retained legacy backend source

Owner: microduck. Microduck runner-origin and frame-policy configuration.

Legacy source only, not a current supported import path or command. Original cross-package namespaces, private imports, target paths, key/account custody, host/network/process actions and fixtures must be ported deliberately before use. Do not add sys.path shims, privileged globals, fake storage or automatic service/firewall actions to make it run. No old module/driver is imported or executed by this extraction; no active backend or minimum dependency changes.

## Source and history

Desktop snapshot `4f72ea86928666189b32f6f05c2c697a37341d06`; exact source baseline `a3de237e9d3137febdd25c7d29c08cd5dce9a41e`; separate mechanical merge `eaa640c4a3f13d0a089978e84d9f5b66a1a9dc0d`. Private phase41 retains original/earlier paths, copy-boundary notes and commit/ref maps. No active package/module/test body changed.

| Original path | Retained path |
|---|---|
| `active-system/origin_service/microduck_config.py` | `legacy/backend/origin_service/microduck_config.py` |

These sources remain outside supported package/build/test entrypoints. Existing source baseline failures remain separate; syntax/history checks do not establish old protocol or current application compatibility. Preserve native signed-worker/authorization checks during a real public-interface port. External publication is not authorized by this source retention.
