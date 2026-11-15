"""Explicit trusted desktop origin and frame policy for Microduck's runner."""
import ipaddress
import re
from urllib.parse import urlsplit

_HOST=re.compile(r'[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*\Z')

def _origin(value,*,allow_loopback):
 if not isinstance(value,str) or not value or len(value)>256:raise ValueError('Invalid origin')
 try:parts=urlsplit(value);port=parts.port
 except ValueError as error:raise ValueError('Invalid origin') from error
 host=parts.hostname
 if not host or parts.username is not None or parts.password is not None or parts.path or parts.query or parts.fragment:raise ValueError('Invalid origin')
 if not _HOST.fullmatch(host) or any(len(label)>63 for label in host.split('.')):raise ValueError('Invalid origin')
 if re.fullmatch(r'[0-9.]+',host):
  try:canonical_ip=str(ipaddress.IPv4Address(host))
  except ValueError as error:raise ValueError('Invalid IP origin') from error
  if host!=canonical_ip:raise ValueError('Invalid IP origin')
 if parts.scheme=='https':
  if port==443:raise ValueError('Default port must be omitted')
 elif not (allow_loopback and parts.scheme=='http' and host in ('127.0.0.1','localhost') and port is not None):raise ValueError('HTTPS origin required')
 if port is not None and not 1<=port<=65535:raise ValueError('Invalid origin port')
 if value!=parts.scheme+'://'+host+(':'+str(port) if port is not None else ''):raise ValueError('Origin must be canonical')
 return value

def runner_origin(value,desktop_origin,*,allow_loopback=False):
 if value is None:return None
 origin=_origin(value,allow_loopback=allow_loopback)
 desktop=_origin(desktop_origin,allow_loopback=True)
 if origin==desktop:raise ValueError('Runner must use a distinct origin')
 return origin

def frame_policy(csp,origin):
 origin=_origin(origin,allow_loopback=True)
 if not isinstance(csp,str) or not csp.strip():raise ValueError('Desktop policy required')
 directives=[part.strip() for part in csp.split(';') if part.strip()]
 rows=[part.split() for part in directives]
 def indexes(name):return [i for i,row in enumerate(rows) if row and row[0].lower()==name]
 frames=indexes('frame-src');defaults=indexes('default-src')
 if len(frames)>1 or len(defaults)!=1:raise ValueError('Ambiguous desktop policy')
 index=frames[0] if frames else None
 sources=(rows[index][1:] if index is not None else rows[defaults[0]][1:])
 if not sources or ("'none'" in sources and len(sources)>1):raise ValueError('Ambiguous frame sources')
 sources=[source for source in sources if source!="'none'"]
 if origin not in sources:sources.append(origin)
 replacement='frame-src '+' '.join(sources)
 if index is None:directives.append(replacement)
 else:directives[index]=replacement
 return '; '.join(directives)


class RunnerFramePolicy:
 """Add the configured frame source to the top-level document response only."""
 def __init__(self,application,origin,base_path=''):
  self.application=application
  self.origin=_origin(origin,allow_loopback=True)
  self.paths={base_path or '/',base_path+'/',base_path+'/index.html'}
 def __call__(self,environ,start_response):
  if environ.get('PATH_INFO') not in self.paths:return self.application(environ,start_response)
  def start(status,headers,exc_info=None):
   if status.startswith('200 '):
    indexes=[i for i,(name,_) in enumerate(headers) if name.lower()=='content-security-policy']
    if len(indexes)!=1:raise ValueError('Expected exactly one document policy')
    headers=list(headers);index=indexes[0];name,value=headers[index];headers[index]=(name,frame_policy(value,self.origin))
   return start_response(status,headers,exc_info)
  return self.application(environ,start)
