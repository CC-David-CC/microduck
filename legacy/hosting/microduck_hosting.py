"""Pure Caddy snippets for the opt-in, immutable Microduck runner candidate.

No network, files or active Caddy state are changed by these functions.
"""
import re

RUNNER_HOST='microduck-runner.ksu.codes'
RUNNER_ORIGIN='https://'+RUNNER_HOST
APP_ORIGIN='https://ksu.codes'
FRAME_CSP="default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; frame-ancestors https://ksu.codes; base-uri 'none'; object-src 'none'; form-action 'none'"
WORKER_CSP="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'"
UUID='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

def validate_profile(site):
    if 'codi_microduck_runner' not in site:return
    value=site['codi_microduck_runner']
    if (not isinstance(value,str) or not re.fullmatch('[0-9a-f]{64}',value) or
        site.get('domain')!='ksu.codes' or site.get('enabled') is not True or
        not site.get('codi_simplified') or site.get('codi_simplified_mode')!='active' or site.get('codi_mount')!=''):
        raise ValueError('Microduck requires an immutable runner SHA on the active KSU root desktop')

def document_csp(base):
    old="frame-src 'self' blob:"
    if not isinstance(base,str) or base.count(old)!=1:raise ValueError('Unexpected desktop frame policy')
    return base.replace(old,old+' '+RUNNER_ORIGIN)

def document_lines(site,base):
    if not site.get('codi_microduck_runner'):return []
    csp=document_csp(base)
    return ['\t@codi_microduck_document path / /index.html',
            '\theader @codi_microduck_document >Content-Security-Policy "'+csp+'"',
            '\theader @codi_microduck_document >Cache-Control "no-store"',
            '\theader @codi_microduck_document >Cross-Origin-Opener-Policy "same-origin"',
            '\theader @codi_microduck_document >Cross-Origin-Embedder-Policy "require-corp"']

def site_lines(site,mode):
    release=site.get('codi_microduck_runner')
    if not release:return []
    validate_profile(site)
    if mode not in ('prepare','production'):raise ValueError('Invalid mode')
    address=('http://' if mode=='prepare' else '')+RUNNER_HOST
    frame_query="{http.request.uri.query}.matches('^challenge="+UUID+"$')"
    # Match the reviewed runner inventory, never expose its manifest or folders.
    return [address+' {', *(['\tbind 127.0.0.1'] if mode=='prepare' else []),
      '\t@microduck_frame {', '\t\tmethod GET HEAD', '\t\tpath /frame', '\t\texpression `'+frame_query+'`', '\t}',
      '\t@microduck_assets {', '\t\tmethod GET HEAD',
      '\t\tpath /frame.js /runner.js /microduck-policy.onnx /microduck-runtime.wasm /runner.js.LEGAL.txt',
      "\t\texpression `{http.request.uri.query} == ''`", '\t}',
      '\t@microduck_js path /frame.js /runner.js', '\t@microduck_worker path /runner.js',
      '\t@microduck_nonworker path /frame.js /microduck-policy.onnx /microduck-runtime.wasm /runner.js.LEGAL.txt',
      '\t@microduck_wasm path /microduck-runtime.wasm', '\t@microduck_policy path /microduck-policy.onnx',
      '\theader {', '\t\tX-Content-Type-Options nosniff', '\t\tReferrer-Policy no-referrer', '\t\tCache-Control no-store', '\t}',
      '\theader @microduck_frame >Content-Type "text/html; charset=utf-8"',
      '\theader @microduck_frame >Content-Security-Policy "'+FRAME_CSP+'"',
      '\theader @microduck_js >Content-Type "text/javascript; charset=utf-8"',
      '\theader @microduck_wasm >Content-Type "application/wasm"',
      '\theader @microduck_policy >Content-Type "application/octet-stream"',
      '\theader @microduck_nonworker >Content-Security-Policy "'+FRAME_CSP+'"',
      '\theader @microduck_worker >Content-Security-Policy "'+WORKER_CSP+'"',
      '\thandle @microduck_frame {', '\t\troot * /srv/codi-connected/microduck-runners/'+release, '\t\tfile_server', '\t}',
      '\thandle @microduck_assets {', '\t\troot * /srv/codi-connected/microduck-runners/'+release, '\t\tfile_server', '\t}',
      '\thandle {', '\t\trespond "Not found" 404', '\t}', '}', '']
