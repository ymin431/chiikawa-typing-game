"""Chiikawa typing garden: dependency-free, single-Pod acid-rain typing game service."""
import gzip, json, os, random, re, secrets, sqlite3, time, unicodedata
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('DATA_DIR', '/tmp/typing-garden-data'))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / 'garden.db'
DURATION = int(os.environ.get('GAME_DURATION', '60'))
LIVES = int(os.environ.get('GAME_LIVES', '5'))
RULES = {'easy': {'interval':3.4,'fall':14,'factor':1}, 'normal':{'interval':2.6,'fall':11,'factor':1.3}, 'hard':{'interval':1.8,'fall':8,'factor':1.6}}
WORDS = {
 'ko': '구름 하늘 바람 잔디 소풍 우유 딸기 복숭아 고양이 토끼 햇살 별빛 달빛 꽃잎 이슬 나무 숲속 바다 파도 여름 봄날 가을 겨울 마음 친구 행복 웃음 선물 산책 노을 무지개 솜사탕 도토리 조약돌 반짝임 민들레 해바라기 물방울 사탕 리본 쿠키 푸딩 마카롱 초콜릿 치이카와 하치와레 우사기 모몽가 랏코 밤하늘 별사탕 다정함 포근함 용기 응원 약속 추억 멜로디 작은꿈 초록빛 나비 튤립 새싹 꽃밭 오솔길 바구니 도시락 딸기우유 크루아상 고구마 감자 요정 소원 기적 오렌지 레몬 민트 피크닉 구름빵 눈송이 은하수 아침 햇볕 고요함 두근두근 사뿐사뿐 몽글몽글 반짝반짝 데굴데굴'.split(),
 'en': 'cloud sky breeze grass picnic milk berry peach kitten rabbit sunshine star moon flower dew tree forest ocean wave summer spring autumn winter heart friend happy smile gift walk sunset rainbow cotton acorn pebble sparkle dandelion sunflower raindrop candy ribbon cookie pudding chocolate dream courage cheer promise memory melody butterfly garden basket lemon mint morning snowflake cozy little gentle blossom wonder'.split()
}

# path -> (file in /app, content type, cacheable). three.js is stored pre-gzipped to keep the ConfigMap small.
STATIC = {'/':('index.html','text/html; charset=utf-8',False),'/style.css':('style.css','text/css; charset=utf-8',False),'/app.js':('app.js','text/javascript; charset=utf-8',False),
 '/favicon.svg':('favicon.svg','image/svg+xml',True),'/three.module.min.js':('three.module.min.js.gz','text/javascript; charset=utf-8',True),
 '/meadow.webp':('meadow.webp','image/webp',True),'/keyboard.mp3':('keyboard.mp3','audio/mpeg',True)}
# Character images are discovered by name: fall-<character>-<n>.<ext> drop from the sky, profile-<character>.<ext> are avatars.
AVATARS = ('chiikawa','hachiware','usagi','rakko','momonga','kurimanju','shisa','kani')
IMAGE = re.compile(r'^(fall|profile)-([a-z]+)(?:-(\d+))?\.(png|webp|jpg|jpeg|gif)$')
IMAGE_TYPES = {'png':'image/png','webp':'image/webp','jpg':'image/jpeg','jpeg':'image/jpeg','gif':'image/gif'}

def character_assets():
 fall={a:[] for a in AVATARS}; profiles={}
 for f in sorted(ROOT.iterdir()):
  m=IMAGE.match(f.name)
  if not m or m.group(2) not in AVATARS: continue
  if m.group(1)=='fall': fall[m.group(2)].append('/'+f.name)
  else: profiles[m.group(2)]='/'+f.name
 return {'fall':{k:v for k,v in fall.items() if v},'profiles':profiles,'names':list(AVATARS)}

def connect():
 c=sqlite3.connect(DB, timeout=10); c.row_factory=sqlite3.Row; c.execute('PRAGMA busy_timeout=10000'); return c

def init_db():
 with connect() as c:
  c.executescript('''CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created REAL, paused_at REAL, paused REAL NOT NULL DEFAULT 0, config TEXT NOT NULL, summary TEXT);
CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, session TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, difficulty TEXT NOT NULL, language TEXT NOT NULL, mode TEXT NOT NULL, score INTEGER NOT NULL, accuracy REAL NOT NULL, cpm REAL NOT NULL, combo INTEGER NOT NULL, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
CREATE INDEX IF NOT EXISTS score_sort ON scores(mode,difficulty,language,score DESC);
CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY, nickname TEXT NOT NULL, message TEXT NOT NULL, avatar TEXT NOT NULL, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
''')
  # Columns added after the first release; existing databases on the PVC are migrated in place.
  for table,column in (('scores','avatar'),('guestbook','session')):
   if column not in [r['name'] for r in c.execute(f'PRAGMA table_info({table})')]: c.execute(f'ALTER TABLE {table} ADD COLUMN {column} TEXT')

def clean(value, maximum, name, minimum=1):
 if not isinstance(value,str): raise ValueError(name+'을 확인해 주세요.')
 value=unicodedata.normalize('NFC',value).strip()
 if not minimum<=len(value)<=maximum or any(ord(ch)<32 for ch in value): raise ValueError(f'{name}은 {minimum}~{maximum}자로 입력해 주세요.')
 return value

def distance(a,b):
 row=list(range(len(b)+1))
 for i,x in enumerate(a,1):
  nxt=[i]
  for j,y in enumerate(b,1): nxt.append(min(nxt[-1]+1,row[j]+1,row[j-1]+(x!=y)))
  row=nxt
 return row[-1]

def summarize(config, attempts, elapsed):
 if not isinstance(attempts,list) or len(attempts)>600: raise ValueError('입력 기록이 너무 많습니다.')
 deck=config['deck']; mode=config['mode']; rule=RULES[config['difficulty']]
 used=set(); attempted=set(); good=total=score=combo=best=0; misses=[]; wrong=[]; previous=-1; next_id=0; actual=elapsed; hits=[]; ticks=[0]*12
 def expire(t):
  nonlocal combo, actual
  if mode!='rain': return False
  for item in deck:
   if item['id'] not in used and item['at']+rule['fall']<=t:
    used.add(item['id']); misses.append(item['text']); combo=0
    if len(misses)>=LIVES:
     actual=item['at']+rule['fall']; return True
  return False
 for a in attempts:
  if not isinstance(a,dict): raise ValueError('입력 기록 형식이 잘못됐어요.')
  at=a.get('at'); idx=a.get('id'); value=a.get('value')
  if isinstance(at,bool) or not isinstance(at,(int,float)) or not 0<=at<=elapsed+.15 or at<previous: raise ValueError('플레이 시간과 입력 기록이 맞지 않아요.')
  previous=at
  if expire(at): break
  if isinstance(idx,bool) or not isinstance(idx,int) or not 0<=idx<len(deck): raise ValueError('단어 기록이 맞지 않아요.')
  item=deck[idx]
  if idx in used or (mode=='rain' and at<item['at']) or (mode!='rain' and idx!=next_id): raise ValueError('아직 입력할 수 없는 단어예요.')
  value=clean(value,160,'입력')
  target=item['text']; span=max(len(target),len(value)); good+=max(0,span-distance(target,value)); total+=span; attempted.add(idx)
  if value==target:
   combo+=1; best=max(best,combo); score+=round(len(target)*10*rule['factor'])+min(combo,20)*5
   used.add(idx); hits.append(target); ticks[min(11,int(at//5))]+=len(target)
   if mode!='rain': next_id+=1
  else:
   combo=0
   if target not in wrong: wrong.append(target)
 expire(elapsed)
 correct_chars=sum(map(len,hits)); actual=max(.1,actual)
 return {'score':score,'accuracy':round(100*good/total,1) if total else 0,'cpm':round(correct_chars/(actual/60)), 'combo':best,'hits':len(hits),'misses':len(misses),'wrong':list(dict.fromkeys(wrong+misses)), 'elapsed':round(actual,1),'timeline':ticks,'mode':mode,'difficulty':config['difficulty'],'language':config['language'],'attempts':len(attempts),'correct_chars':correct_chars}

class Handler(BaseHTTPRequestHandler):
 server_version='TypingGarden/1.0'
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
    difficulty=q.get('difficulty',['normal'])[0]; language=q.get('language',['ko'])[0]; mode=q.get('mode',['rain'])[0]
    with connect() as c: rows=c.execute('SELECT nickname,avatar,score,accuracy,cpm,combo,created FROM scores WHERE difficulty=? AND language=? AND mode=? ORDER BY score DESC, accuracy DESC, created ASC LIMIT 30',(difficulty,language,mode)).fetchall()
    return self.send(200,{'items':[dict(r) for r in rows]})
   if p.path=='/api/guestbook':
    with connect() as c: rows=c.execute('SELECT nickname,message,avatar,created FROM guestbook ORDER BY id DESC LIMIT 60').fetchall()
    return self.send(200,{'items':[dict(r) for r in rows]})
   if p.path=='/api/assets': return self.send(200,character_assets())
   if p.path=='/api/stats':
    with connect() as c:
     runs=c.execute('SELECT COUNT(*) FROM sessions WHERE summary IS NOT NULL').fetchone()[0]
    return self.send(200,{'games':runs})
   m=IMAGE.match(p.path[1:])
   if m and (ROOT/p.path[1:]).is_file(): return self.send(200,(ROOT/p.path[1:]).read_bytes(),IMAGE_TYPES[m.group(4)],{'Cache-Control':'public, max-age=3600'})
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
     mode=data.get('mode','rain'); difficulty=data.get('difficulty','normal'); lang=data.get('language','ko')
     if mode!='rain' or difficulty not in RULES or lang not in WORDS: raise ValueError('게임 설정을 확인해 주세요.')
     source=[w for w in WORDS[lang] if len(w)<=({'easy':4,'normal':6,'hard':12}[difficulty] if lang=='ko' else {'easy':6,'normal':9,'hard':15}[difficulty])]
     shuffled=[]
     while len(shuffled)<160:
      batch=source[:]; random.SystemRandom().shuffle(batch); shuffled.extend(batch)
     deck=[{'id':i,'text':w,'at':round(.5+i*RULES[difficulty]['interval'],2),'lane':(i*3+random.randrange(3))%7,'character':i%3} for i,w in enumerate(shuffled[:160])]
     config={'mode':mode,'difficulty':difficulty,'language':lang,'duration':DURATION,'lives':LIVES,'rule':RULES[difficulty],'deck':deck}; sid=secrets.token_urlsafe(24)
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
      # One form after a game: the score goes to the ranking (if anything was caught) and an optional note to the guestbook.
      if row['summary'] is None: raise ValueError('게임을 먼저 완료해 주세요.')
      nickname=clean(data.get('nickname'),12,'닉네임'); summary=json.loads(row['summary']); avatar=data.get('avatar')
      if avatar not in AVATARS: raise ValueError('프로필 캐릭터를 골라 주세요.')
      message=data.get('message') or ''
      if message: message=clean(message,140,'방명록')
      if c.execute('SELECT 1 FROM scores WHERE session=?',(sid,)).fetchone() or c.execute('SELECT 1 FROM guestbook WHERE session=?',(sid,)).fetchone(): raise ValueError('이미 등록한 기록이에요.')
      if summary['hits']==0 and not message: raise ValueError('잡은 친구가 없으면 방명록만 남길 수 있어요.')
      if summary['hits']>0: c.execute('INSERT INTO scores(session,nickname,avatar,difficulty,language,mode,score,accuracy,cpm,combo) VALUES(?,?,?,?,?,?,?,?,?,?)',(sid,nickname,avatar,config['difficulty'],config['language'],config['mode'],summary['score'],summary['accuracy'],summary['cpm'],summary['combo']))
      if message: c.execute('INSERT INTO guestbook(nickname,message,avatar,session) VALUES(?,?,?,?)',(nickname,message,avatar,sid))
      return self.send(201,{'ranked':summary['hits']>0,'note':bool(message)})
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
     result=summarize(config,data.get('attempts',[]),min(DURATION,client_elapsed)); c.execute('UPDATE sessions SET summary=? WHERE id=?',(json.dumps(result,ensure_ascii=False),sid)); return self.send(200,result)
    return self.send(404,{'error':'요청을 찾을 수 없어요.'})
  except (ValueError,TypeError,KeyError,OverflowError): self.send(400,{'error':str(__import__('sys').exc_info()[1]) or '입력을 확인해 주세요.'})
  except sqlite3.Error: self.send(503,{'error':'기록을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'})
  except (BrokenPipeError,ConnectionResetError): pass

if __name__=='__main__':
 init_db(); port=int(os.environ.get('PORT','8080')); host=os.environ.get('BIND_HOST','0.0.0.0')
 server=ThreadingHTTPServer((host,port),Handler); server.daemon_threads=True
 print(f'Typing garden listening on http://{host}:{port}',flush=True); server.serve_forever()
