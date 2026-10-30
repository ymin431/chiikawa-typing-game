"""BONK GARDEN: dependency-free, single-Pod whack-a-mole game service with ranking and guestbook."""
import gzip, json, os, random, secrets, sqlite3, time, unicodedata
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('DATA_DIR', '/tmp/typing-garden-data'))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / 'garden.db'
DURATION = int(os.environ.get('GAME_DURATION', '60'))
# More holes, shorter stays and faster spawns at each level.
RULES = {'easy': {'holes':6,'cols':3,'interval':.95,'stay':1.35,'factor':1},
         'normal': {'holes':9,'cols':3,'interval':.72,'stay':1.05,'factor':1.3},
         'hard': {'holes':12,'cols':4,'interval':.5,'stay':.78,'factor':1.6}}
KINDS = {'easy': (('mole',.84),('gold',.08),('bunny',.08)), 'normal': (('mole',.78),('gold',.08),('bunny',.14)), 'hard': (('mole',.74),('gold',.08),('bunny',.18))}
POINTS = {'mole':10,'gold':30,'bunny':-20}

# path -> (file in /app, content type, cacheable). three.js is stored pre-gzipped to keep the ConfigMap small.
STATIC = {'/':('index.html','text/html; charset=utf-8',False),'/style.css':('style.css','text/css; charset=utf-8',False),'/app.js':('app.js','text/javascript; charset=utf-8',False),
 '/favicon.svg':('favicon.svg','image/svg+xml',True),'/three.module.min.js':('three.module.min.js.gz','text/javascript; charset=utf-8',True),
 '/click.mp3':('keyboard.mp3','audio/mpeg',True)}

def connect():
 c=sqlite3.connect(DB, timeout=10); c.row_factory=sqlite3.Row; c.execute('PRAGMA busy_timeout=10000'); return c

def init_db():
 with connect() as c:
  c.executescript('''CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created REAL, paused_at REAL, paused REAL NOT NULL DEFAULT 0, config TEXT NOT NULL, summary TEXT);
CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, session TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, difficulty TEXT NOT NULL, language TEXT NOT NULL, mode TEXT NOT NULL, score INTEGER NOT NULL, accuracy REAL NOT NULL, cpm REAL NOT NULL, combo INTEGER NOT NULL, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
CREATE INDEX IF NOT EXISTS score_sort ON scores(mode,difficulty,language,score DESC);
CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY, nickname TEXT NOT NULL, message TEXT NOT NULL, avatar TEXT NOT NULL, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, last REAL NOT NULL);
''')
  # Columns added after the first release; existing databases on the PVC are migrated in place.
  for table,column,kind in (('scores','reaction','REAL'),('guestbook','session','TEXT')):
   if column not in [r['name'] for r in c.execute(f'PRAGMA table_info({table})')]: c.execute(f'ALTER TABLE {table} ADD COLUMN {column} {kind}')

def clean(value, maximum, name, minimum=1):
 if not isinstance(value,str): raise ValueError(name+'을 확인해 주세요.')
 value=unicodedata.normalize('NFC',value).strip()
 if not minimum<=len(value)<=maximum or any(ord(ch)<32 for ch in value): raise ValueError(f'{name}은 {minimum}~{maximum}자로 입력해 주세요.')
 return value

def make_deck(difficulty):
 """Pre-plan every pop so the server can verify hits: (time, hole, how long it stays up, which critter)."""
 rule=RULES[difficulty]; rng=random.SystemRandom(); kinds,weights=zip(*KINDS[difficulty])
 busy=[0.0]*rule['holes']; deck=[]; t=.8
 while t<DURATION-.3:
  free=[h for h in range(rule['holes']) if busy[h]<=t]
  if free:
   kind=rng.choices(kinds,weights)[0]; stay=round(rule['stay']*(.75 if kind=='gold' else 1)*rng.uniform(.9,1.1),3); hole=rng.choice(free)
   deck.append({'id':len(deck),'at':round(t,3),'hole':hole,'stay':stay,'kind':kind}); busy[hole]=t+stay+.35
  t+=rule['interval']*rng.uniform(.7,1.3)
 return deck

def summarize(config, hits, clicks, elapsed):
 if not isinstance(hits,list) or len(hits)>600: raise ValueError('기록이 너무 많아요.')
 if isinstance(clicks,bool) or not isinstance(clicks,int) or not len(hits)<=clicks<=5000: raise ValueError('클릭 기록이 맞지 않아요.')
 deck=config['deck']; rule=config['rule']; used=set(); escaped=set(); previous=-1; score=combo=best=caught=bunnies=0; reactions=[]
 def expire(t):
  nonlocal combo
  for p in deck:
   if p['id'] not in used and p['id'] not in escaped and p['kind']!='bunny' and p['at']+p['stay']<=t: escaped.add(p['id']); combo=0
 for h in hits:
  if not isinstance(h,dict): raise ValueError('기록 형식이 잘못됐어요.')
  at=h.get('at'); idx=h.get('id')
  if isinstance(at,bool) or not isinstance(at,(int,float)) or not 0<=at<=elapsed+.15 or at<previous: raise ValueError('플레이 시간과 기록이 맞지 않아요.')
  if isinstance(idx,bool) or not isinstance(idx,int) or not 0<=idx<len(deck) or idx in used: raise ValueError('두더지 기록이 맞지 않아요.')
  p=deck[idx]
  if not p['at']<=at<=p['at']+p['stay']+.12: raise ValueError('이미 들어간 두더지예요.')
  previous=at; expire(at); used.add(idx)
  if p['kind']=='bunny': bunnies+=1; combo=0; score+=round(POINTS['bunny']*rule['factor'])
  else:
   combo+=1; best=max(best,combo); caught+=1; reactions.append(at-p['at'])
   score+=round(POINTS[p['kind']]*rule['factor'])+min(combo,20)*2
 expire(elapsed)
 return {'score':max(0,score),'accuracy':round(100*caught/clicks,1) if clicks else 0,'reaction':round(1000*sum(reactions)/len(reactions)) if reactions else 0,
  'combo':best,'hits':caught,'bunnies':bunnies,'escaped':len(escaped),'clicks':clicks,'elapsed':round(max(.1,elapsed),1),'mode':'mole','difficulty':config['difficulty']}

class Handler(BaseHTTPRequestHandler):
 server_version='BonkGarden/1.0'
 def log_message(self, fmt, *args):
  # Never log query strings, request bodies or credentials.
  print(f'{self.command} {urlparse(self.path).path} {args[1] if len(args)>1 else ""}',flush=True)
 def send(self,status,data,typ='application/json; charset=utf-8',headers=None):
  raw=json.dumps(data,ensure_ascii=False).encode() if isinstance(data,(dict,list)) else data
  self.send_response(status); self.send_header('Content-Type',typ); self.send_header('Content-Length',str(len(raw)))
  for k,v in (headers or {'Cache-Control':'no-store'}).items(): self.send_header(k,v)
  self.send_header('X-Content-Type-Options','nosniff'); self.send_header('Referrer-Policy','same-origin'); self.send_header('X-Frame-Options','DENY')
  self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
  self.end_headers()
  if self.command!='HEAD': self.wfile.write(raw)
 def do_HEAD(self): self.do_GET()
 def do_GET(self):
  p=urlparse(self.path); q=parse_qs(p.query)
  try:
   if p.path=='/api/health': return self.send(200,{'ok':True})
   if p.path=='/api/ready':
    with connect() as c: c.execute('SELECT 1 FROM sessions LIMIT 1').fetchone()
    return self.send(200,{'ready':True})
   if p.path=='/api/leaderboard':
    difficulty=q.get('difficulty',['normal'])[0]
    with connect() as c: rows=c.execute("SELECT nickname,score,accuracy,reaction,combo,created FROM scores WHERE mode='mole' AND difficulty=? ORDER BY score DESC, accuracy DESC, created ASC LIMIT 30",(difficulty,)).fetchall()
    return self.send(200,{'items':[dict(r) for r in rows]})
   if p.path=='/api/guestbook':
    with connect() as c: rows=c.execute('SELECT nickname,message,created FROM guestbook ORDER BY id DESC LIMIT 60').fetchall()
    return self.send(200,{'items':[dict(r) for r in rows]})
   if p.path=='/api/stats':
    with connect() as c: runs=c.execute('''SELECT COUNT(*) FROM sessions WHERE summary LIKE '%"mode": "mole"%' ''').fetchone()[0]
    return self.send(200,{'games':runs})
   if p.path not in STATIC or not (ROOT/STATIC[p.path][0]).is_file(): return self.send(404,{'error':'페이지를 찾을 수 없어요.'})
   fn,typ,cache=STATIC[p.path]; raw=(ROOT/fn).read_bytes(); headers={'Cache-Control':'public, max-age=86400' if cache else 'no-store'}
   if fn.endswith('.gz'):
    headers['Vary']='Accept-Encoding'
    if 'gzip' in self.headers.get('Accept-Encoding',''): headers['Content-Encoding']='gzip'
    else: raw=gzip.decompress(raw)
   self.send(200,raw,typ,headers)
  except (sqlite3.Error,OSError): self.send(503,{'error':'저장소를 준비 중이에요. 잠시 후 다시 시도해 주세요.'})
 def do_POST(self):
  try:
   origin=self.headers.get('Origin')
   if origin and urlparse(origin).netloc!=self.headers.get('Host'): return self.send(403,{'error':'다른 사이트에서는 요청할 수 없어요.'})
   length=int(self.headers.get('Content-Length','0'))
   if length<=0 or length>65536: return self.send(413,{'error':'요청 크기를 확인해 주세요.'})
   if 'application/json' not in self.headers.get('Content-Type',''): return self.send(415,{'error':'JSON 요청이 필요해요.'})
   data=json.loads(self.rfile.read(length))
   if not isinstance(data,dict): raise ValueError('요청 형식이 잘못됐어요.')
   p=urlparse(self.path).path; now=time.time()
   with connect() as c:
    c.execute('BEGIN IMMEDIATE')
    if p=='/api/start':
     difficulty=data.get('difficulty','normal')
     if difficulty not in RULES: raise ValueError('난이도를 확인해 주세요.')
     config={'mode':'mole','difficulty':difficulty,'duration':DURATION,'rule':RULES[difficulty],'deck':make_deck(difficulty)}; sid=secrets.token_urlsafe(24)
     c.execute('DELETE FROM sessions WHERE created < ? AND summary IS NULL',(now-86400,))
     c.execute('INSERT INTO sessions(id,created,config) VALUES(?,?,?)',(sid,now,json.dumps(config,ensure_ascii=False)))
     return self.send(201,{'session':sid,**config})
    if p in ('/api/pause','/api/resume','/api/finish','/api/register'):
     sid=data.get('session')
     if not isinstance(sid,str) or len(sid)>100: raise ValueError('게임을 먼저 시작해 주세요.')
     row=c.execute('SELECT * FROM sessions WHERE id=?',(sid,)).fetchone()
     if row is None: raise ValueError('게임이 만료됐어요. 다시 시작해 주세요.')
     config=json.loads(row['config'])
     if p=='/api/register':
      if row['summary'] is None: raise ValueError('게임을 먼저 완료해 주세요.')
      nickname=clean(data.get('nickname'),12,'닉네임'); summary=json.loads(row['summary'])
      if summary['hits']==0: raise ValueError('잡은 두더지가 있어야 랭킹에 올릴 수 있어요.')
      if c.execute('SELECT 1 FROM scores WHERE session=?',(sid,)).fetchone(): raise ValueError('이미 등록한 기록이에요.')
      c.execute('INSERT INTO scores(session,nickname,difficulty,language,mode,score,accuracy,cpm,reaction,combo) VALUES(?,?,?,?,?,?,?,?,?,?)',(sid,nickname,config['difficulty'],'-','mole',summary['score'],summary['accuracy'],0,summary['reaction'],summary['combo']))
      return self.send(201,{'ok':True})
     if row['summary'] is not None:
      if p=='/api/finish': return self.send(200,json.loads(row['summary']))
      raise ValueError('이미 끝난 게임이에요.')
     if now-row['created']>7200: raise ValueError('게임이 만료됐어요. 다시 시작해 주세요.')
     elapsed=(row['paused_at'] or now)-row['created']-row['paused']
     if p=='/api/pause':
      if row['paused_at'] is None: c.execute('UPDATE sessions SET paused_at=? WHERE id=?',(now,sid))
      return self.send(200,{'ok':True})
     if p=='/api/resume':
      if row['paused_at'] is not None: c.execute('UPDATE sessions SET paused=paused+?,paused_at=NULL WHERE id=?',(now-row['paused_at'],sid))
      return self.send(200,{'ok':True})
     client_elapsed=data.get('elapsed')
     if isinstance(client_elapsed,bool) or not isinstance(client_elapsed,(int,float)) or not .1<=client_elapsed<=DURATION+.5 or client_elapsed>elapsed+1.5: raise ValueError('게임 시간을 확인할 수 없어요.')
     result=summarize(config,data.get('hits',[]),data.get('clicks',0),min(DURATION,client_elapsed)); c.execute('UPDATE sessions SET summary=? WHERE id=?',(json.dumps(result,ensure_ascii=False),sid)); return self.send(200,result)
    if p=='/api/guestbook':
     name=clean(data.get('nickname'),12,'닉네임'); msg=clean(data.get('message'),140,'방명록')
     key='guest:'+self.client_address[0]; last=c.execute('SELECT last FROM rate_limits WHERE key=?',(key,)).fetchone()
     if last and now-last[0]<10: return self.send(429,{'error':'조금만 쉬어 가요. 10초 뒤에 다시 남길 수 있어요.'})
     c.execute('INSERT OR REPLACE INTO rate_limits VALUES(?,?)',(key,now)); c.execute('INSERT INTO guestbook(nickname,message,avatar) VALUES(?,?,?)',(name,msg,''))
     return self.send(201,{'ok':True})
    return self.send(404,{'error':'요청을 찾을 수 없어요.'})
  except (ValueError,TypeError,KeyError,OverflowError): self.send(400,{'error':str(__import__('sys').exc_info()[1]) or '입력을 확인해 주세요.'})
  except sqlite3.Error: self.send(503,{'error':'기록을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'})
  except (BrokenPipeError,ConnectionResetError): pass

if __name__=='__main__':
 init_db(); port=int(os.environ.get('PORT','8080')); host=os.environ.get('BIND_HOST','0.0.0.0')
 server=ThreadingHTTPServer((host,port),Handler); server.daemon_threads=True
 print(f'Bonk garden listening on http://{host}:{port}',flush=True); server.serve_forever()
