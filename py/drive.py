import json, subprocess, sys, os, time
p = subprocess.Popen([".venv/bin/python","-I","sidecar.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, "DOOM_FRAMES_DIR": "frames"})
print("hello", p.stdout.readline().strip()[:160])
n=0
def call(op, **args):
    global n; n+=1
    p.stdin.write(json.dumps({"id":n,"op":op,"args":args})+"\n"); p.stdin.flush()
    r=json.loads(p.stdout.readline())
    if not r["ok"]: print("ERR", op, r["error"]); return r
    res=r["result"]; fj=res.pop("frame_jpeg",None); aj=res.pop("automap_jpeg",None)
    print(f"--- {op} {args if op!='act' else args['actions']} took {res.get('took_ms')}ms frame={len(fj or '')//1024}KB automap={len(aj or '')//1024}KB")
    print(json.dumps({k:v for k,v in res.items() if k not in ('took_ms',)})[:1800])
    return res
call("games")
call("start", game="freedoom1", map="E1M1", skill=3)
call("act", actions=[{"turn": 90}, {"move":"forward","tics":35}])
call("act", actions=[{"turn": -90}])
r=call("act", actions=[{"attack": 2}])
call("act", actions=[{"move":"forward","tics":70}, {"use": True}])
call("act", actions=[{"wait": 10}], image="both")
call("state")
call("stop")
p.stdin.close()
