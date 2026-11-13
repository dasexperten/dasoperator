#!/usr/bin/env python3
"""Owner-operated, existing-client Gmail readonly consent. Never prints grant values.

Run on the Mac hosting the browser. Open the displayed official Google URL and
approve personally. This does not install credentials or alter the sales grant.
The verified company grant is staged privately for Mina to mirror/install.
"""
import argparse,base64,hashlib,http.server,json,os,pathlib,secrets,subprocess,time,urllib.parse,urllib.request
parser=argparse.ArgumentParser();parser.add_argument('--repo',default=str(pathlib.Path.home()/'repos/organizacia'));parser.add_argument('--check',action='store_true');parser.add_argument('--state-dir',default=str(pathlib.Path.home()/'.codex/private/online-daily-consent'));args=parser.parse_args()
read=lambda f:subprocess.check_output(['git','-C',args.repo,'show','origin/secrets:SECRETS/'+f],text=True)
client=json.loads(read('client_secret_949857646934-6ajcdpaqq3bgjob9u5g15ep03o5poae0.apps.googleusercontent.com.json'))['installed']
assert 'http://localhost' in client['redirect_uris']
assert client['auth_uri']=='https://accounts.google.com/o/oauth2/auth' and client['token_uri']=='https://oauth2.googleapis.com/token'
if args.check:print('Existing installed Google client supports localhost; requested scope is Gmail readonly.');raise SystemExit(0)
folder=pathlib.Path(args.state_dir);folder.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(folder,0o700)
state=secrets.token_urlsafe(32);verifier=secrets.token_urlsafe(64);challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=');result={'done':False}
class Callback(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  parsed=urllib.parse.urlsplit(self.path);q=urllib.parse.parse_qs(parsed.query)
  if parsed.path!='/callback' or q.get('state',[''])[0]!=state:self.send_error(400);return
  if 'error' in q:self.send_error(403,'Consent not granted');result['done']=True;return
  try:
   form={'client_id':client['client_id'],'client_secret':client['client_secret'],'code':q['code'][0],'code_verifier':verifier,'redirect_uri':redirect,'grant_type':'authorization_code'}
   with urllib.request.urlopen(urllib.request.Request(client['token_uri'],data=urllib.parse.urlencode(form).encode()),timeout=30) as r:grant=json.load(r)
   with urllib.request.urlopen(urllib.request.Request('https://gmail.googleapis.com/gmail/v1/users/me/profile',headers={'Authorization':'Bearer '+grant['access_token']}),timeout=30) as r:profile=json.load(r)
   if profile.get('emailAddress','').lower()!='dasexperten@gmail.com' or not grant.get('refresh_token'):raise ValueError('Company identity or offline grant not verified')
   path=folder/'verified-grant.json';fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
   with os.fdopen(fd,'w') as f:json.dump({'email':'dasexperten@gmail.com','refreshToken':grant['refresh_token'],'scope':grant.get('scope',''),'verified_at':time.time()},f)
   self.send_response(200);self.send_header('Content-Type','text/plain; charset=utf-8');self.end_headers();self.wfile.write(b'Company Gmail identity verified. You may close this tab. Mina must finish secure ERP installation.');print('Company Gmail readonly consent verified; grant staged privately for installation.',flush=True)
  except Exception:self.send_error(502,'Grant not installed; return to the assistant');print('Consent exchange or company identity verification failed; no credential printed.',flush=True)
  result['done']=True
server=http.server.HTTPServer(('127.0.0.1',0),Callback);server.timeout=1;redirect=f'http://localhost:{server.server_port}/callback'
url=client['auth_uri']+'?'+urllib.parse.urlencode({'client_id':client['client_id'],'redirect_uri':redirect,'response_type':'code','scope':'https://www.googleapis.com/auth/gmail.readonly','access_type':'offline','prompt':'consent','login_hint':'dasexperten@gmail.com','state':state,'code_challenge':challenge,'code_challenge_method':'S256'})
(folder/'consent-url.txt').write_text(url);os.chmod(folder/'consent-url.txt',0o600)
print('Official company Gmail readonly consent URL saved in private consent-url.txt; approve Google Allow personally on this Mac.',flush=True)
end=time.time()+1200
while not result['done'] and time.time()<end:server.handle_request()
server.server_close()
if not result['done']:print('Consent window expired; no credentials changed.',flush=True)
