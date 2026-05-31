import re, os, logging
from flask import Flask, render_template, request, jsonify, send_from_directory
from werkzeug.utils import secure_filename

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['RESOURCES_FOLDER'] = 'resources'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(app.config['RESOURCES_FOLDER'], exist_ok=True)

# ---------- AST 解析器 (与之前相同，包含 delay、exfont 过滤) ----------
def parse_ast(text):
    scenes = {}
    pattern = re.compile(r'\["(\w+)"\]\s*=\s*\{')
    for m in pattern.finditer(text):
        sid = m.group(1)
        start = m.end()
        depth, pos = 1, start
        while depth > 0 and pos < len(text):
            if text[pos] == '{': depth += 1
            elif text[pos] == '}': depth -= 1
            pos += 1
        block = text[start:pos-1]
        scene = parse_scene_block(block)
        if scene: scenes[sid] = scene
    return {'scenes': scenes}

def parse_scene_block(block):
    commands, texts = [], []
    linknext = linkback = line = None
    delay = None
    lines = block.split('\n')
    i = 0
    while i < len(lines):
        ln = lines[i].strip()
        if not ln: i += 1; continue
        if ln.startswith('text = {') or ln == 'text = {':
            buf = ln[ln.index('{'):]
            depth = buf.count('{') - buf.count('}')
            while depth > 0 and i < len(lines)-1:
                i += 1
                next_line = lines[i].strip()
                buf += '\n' + next_line
                depth = buf.count('{') - buf.count('}')
            texts.extend(parse_text_block(buf))
        elif ln.startswith('delay = {'):
            buf = ln[ln.index('{'):]
            depth = buf.count('{') - buf.count('}')
            while depth > 0 and i < len(lines)-1:
                i += 1
                next_line = lines[i].strip()
                buf += '\n' + next_line
                depth = buf.count('{') - buf.count('}')
            delay = parse_delay_block(buf)
        elif ln.startswith('linknext'): linknext = _extract_string(ln)
        elif ln.startswith('linkback'): linkback = _extract_string(ln)
        elif ln.startswith('line'):
            m = re.search(r'\d+', ln)
            if m: line = int(m.group())
        elif ln.startswith('{"') or ln.startswith('{'):
            cmd = parse_command(ln)
            if cmd: commands.append(cmd)
        i += 1
    return {'commands':commands, 'texts':texts, 'linknext':linknext, 'linkback':linkback, 'line':line, 'delay':delay}

def parse_delay_block(content):
    entries = []
    pattern = re.compile(r'\[(\d+)\]\s*=\s*\{')
    for m in pattern.finditer(content):
        t_ms = int(m.group(1))
        start, depth, pos = m.end(), 1, m.end()
        while depth > 0 and pos < len(content):
            if content[pos]=='{': depth+=1
            elif content[pos]=='}': depth-=1
            pos+=1
        block = content[start:pos-1]
        cmds = []
        cmd_re = re.compile(r'(\{"(\w+)"\s*,[^}]+\})')
        for cm in cmd_re.finditer(block):
            cmd = parse_command(cm.group(1))
            if cmd: cmds.append(cmd)
        entries.append({'time':t_ms, 'commands':cmds})
    entries.sort(key=lambda x:x['time'])
    return entries

def parse_command(s):
    m = re.match(r'\{"(\w+)"', s)
    if not m: return None
    cmd = {'cmd': m.group(1)}
    rest = s[m.end():]
    pairs = re.findall(r'(\w+)\s*=\s*(-?\d+|"[^"]*"|[^,}]+)', rest)
    for k,v in pairs:
        v = v.strip()
        if v.startswith('"') and v.endswith('"'): v = v[1:-1]
        elif v.isdigit() or (v.startswith('-') and v[1:].isdigit()): v = int(v)
        cmd[k] = v
    return cmd

def parse_text_block(content):
    results, vo_commands = [], []
    lang_re = re.compile(r'(\w+)\s*=\s*\{')
    for m in lang_re.finditer(content):
        lang = m.group(1)
        start, depth, pos = m.end(), 1, m.end()
        while depth > 0 and pos < len(content):
            if content[pos]=='{': depth+=1
            elif content[pos]=='}': depth-=1
            pos+=1
        block = content[start:pos-1]
        if lang == 'vo':
            vo_commands.extend(_parse_vo_entries(block))
        else:
            entries = _parse_lang_entries(block, lang)
            for e in entries:
                e['_lang'] = lang
                results.append(e)
    merged, idx_map = [], {}
    for e in results:
        idx = e['_idx']
        if idx not in idx_map:
            idx_map[idx] = {}
            merged.append(idx_map[idx])
        idx_map[idx][e['_lang']] = e.get('_text','')
        if 'name' in e: idx_map[idx].setdefault('name',{}).update(e['name'])
    valid = []
    for item in merged:
        has_text = False
        for l in ['cn','ja','en','tw']:
            t = item.get(l,'')
            if t and not t.startswith('*') and t not in ('rt2','exfont','rt','exfontend','vo'):
                has_text = True; break
        if has_text: valid.append(item)
    if vo_commands and len(valid)>0: valid[0]['vo'] = vo_commands
    return valid

def _parse_vo_entries(block):
    entries = []
    vo_re = re.compile(r'\{("vo")\s*,\s*([^}]+)\}')
    for m in vo_re.finditer(block):
        param_str = m.group(2)
        cmd = {'cmd':'vo'}
        pairs = re.findall(r'(\w+)\s*=\s*"([^"]*)"', param_str)
        for k,v in pairs: cmd[k] = v
        entries.append(cmd)
    return entries

def _parse_lang_entries(block, lang):
    entries, entry_re = [], re.compile(r'\{')
    for m in entry_re.finditer(block):
        start, depth, pos = m.start(), 1, m.start()+1
        while depth > 0 and pos < len(block):
            if block[pos]=='{': depth+=1
            elif block[pos]=='}': depth-=1
            pos+=1
        entry_str = block[start+1:pos-1]
        entry = _parse_entry(entry_str, lang)
        if entry:
            entry['_idx'] = len(entries)
            entries.append(entry)
    return entries

def _parse_entry(s, lang):
    result = {}
    name_match = re.search(r'name\s*=\s*(\{[^}]*\}|"[^"]*")', s)
    if name_match:
        part = name_match.group(1)
        if part.startswith('{'):
            names = re.findall(r'"([^"]*)"', part)
        else:
            names = [part[1:-1]]
        if names:
            name_obj = {}
            if len(names)>=1: name_obj[lang] = names[0]
            if len(names)>=2: name_obj['en'] = names[1]
            result['name'] = name_obj
        remaining = s[:name_match.start()] + s[name_match.end():]
    else:
        remaining = s
    # 过滤 exfont, gaiji, rt2 等
    pattern = re.compile(r'"([^"]*)"|\{("gaiji")\s*,\s*([^}]+)\}|\{("exfont")\s*,[^}]+\}|\{("exfontend")\s*\}|\{("rt2")\s*\}|\{("rt")\s*\}')
    fragments = []
    for m in pattern.finditer(remaining):
        if m.group(1) is not None:
            txt = m.group(1)
            if txt not in ('rt2','exfont','rt','exfontend','vo') and not txt.startswith('*'):
                fragments.append(txt)
        elif m.group(2) == 'gaiji':
            gaiji_params = m.group(3)
            t = re.search(r'text\s*=\s*"([^"]*)"', gaiji_params)
            if t: fragments.append(t.group(1))
        # exfont 等忽略
    if fragments:
        result['_text'] = ''.join(fragments).strip()
    else:
        all_strings = re.findall(r'"([^"]*)"', remaining)
        skip_tags = {'rt2','exfont','rt','exfontend','vo'}
        text_candidates = [x for x in all_strings if x not in skip_tags and not x.startswith('*')]
        if text_candidates: result['_text'] = text_candidates[0]
    return result if '_text' in result or 'name' in result else None

def _extract_string(s):
    m = re.search(r'"([^"]*)"', s)
    return m.group(1) if m else None

# ---------- IPT 解析器 ----------
def parse_ipt(text):
    layers = []
    mode_match = re.search(r'mode\s*=\s*"(\w+)"', text)
    mode = mode_match.group(1) if mode_match else 'diff'
    base_match = re.search(r'base\s*=\s*\{([^}]+)\}', text)
    if base_match:
        content = base_match.group(1).strip()
        base = {}
        file_match = re.search(r'"([^"]+)"', content)
        if file_match: base['file'] = file_match.group(1)
        w_match = re.search(r'w\s*=\s*(\d+)', content)
        if w_match: base['w'] = int(w_match.group(1))
        h_match = re.search(r'h\s*=\s*(\d+)', content)
        if h_match: base['h'] = int(h_match.group(1))
        layers.append({'type':'base', **base})
    layer_pattern = re.compile(r'\{\s*id\s*=\s*(\d+)\s*,\s*file\s*=\s*"([^"]+)"\s*,\s*x\s*=\s*(-?\d+)\s*,\s*y\s*=\s*(-?\d+)\s*\}')
    for m in layer_pattern.finditer(text):
        layers.append({'type':'layer','id':int(m.group(1)),'file':m.group(2),'x':int(m.group(3)),'y':int(m.group(4))})
    return {'mode':mode, 'layers':layers}

# ---------- 路由 ----------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/upload', methods=['POST'])
def upload():
    if 'file' not in request.files: return jsonify({'error':'No file'}),400
    file = request.files['file']
    if file.filename == '': return jsonify({'error':'Empty filename'}),400
    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)
    return jsonify({'status':'ok', 'filename':filename})

@app.route('/api/files')
def list_files():
    try:
        files = [f for f in os.listdir(app.config['UPLOAD_FOLDER']) if f.lower().endswith(('.lua','.txt','.ast'))]
        return jsonify(files)
    except Exception as e:
        return jsonify({'error':str(e)}),500

@app.route('/api/parse/<filename>')
def parse_file(filename):
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], secure_filename(filename))
    if not os.path.exists(filepath): return jsonify({'error':'File not found'}),404
    with open(filepath, 'r', encoding='utf-8') as f:
        text = f.read()
    data = parse_ast(text)
    return jsonify(data)

@app.route('/resources/<path:filename>')
def resource_file(filename):
    full_path = os.path.join(app.config['RESOURCES_FOLDER'], filename)
    if os.path.isfile(full_path): return send_from_directory(app.config['RESOURCES_FOLDER'], filename)
    if '.' not in os.path.basename(filename):
        for ext in ['.ipt','.png','.ogg']:
            alt = full_path + ext
            if os.path.isfile(alt): return send_from_directory(app.config['RESOURCES_FOLDER'], filename+ext)
    return jsonify({'error':'File not found'}),404

@app.route('/api/ipt/<path:filename>')
def ipt_layers_api(filename):
    filepath = os.path.join(app.config['RESOURCES_FOLDER'], filename)
    if not os.path.isfile(filepath):
        filepath += '.ipt'
        if not os.path.isfile(filepath): return jsonify({'error':'IPT file not found'}),404
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    data = parse_ipt(content)
    ipt_dir = os.path.dirname(filename)
    for layer in data['layers']:
        fname = layer.get('file','')
        if fname: layer['url'] = f"/resources/{ipt_dir}/{fname}.png"
    return jsonify(data)

@app.route('/api/sample')
def sample():
    sample_text = r'''
ast = {
  ["0096_00004"] = {
    {"bgm", file="bgm08", vol=100},
    {"bg", id=2, file="bg05_1_00000", x=0, y=0, lv=2, path=":bg/", sync=0, ax=805, ay=455, bx=-5, by=-5},
    {"fg", file="hinami_02m_00002", file1="hinami_02m_00101", file2="hinami_02m_00202", path=":fg/hinami_02m/", id=5, lv=5, head="hinami_02m", ch_origin="ヒナミ", ch="ヒナミ5", mw="mw", sync=0, mode=3, x=395, y=-5},
    {"fg", file="rei_02m_00002", file1="rei_02m_00101", file3="rei_02m_00310", path=":fg/rei_02m/", id=9, lv=9, head="rei_02m", ch_origin="礼", ch="礼9", mw="mw", sync=0, mode=3, x=-405, y=-5},
    {"transitiontime", time=300},
    {"fgact", ch="ヒナミ5", id=5, act="振動下", loop=1, size=-20, time=250, ease="easeinout_sine"},
    {"fgact", ch="礼9", id=9, act="振動下", loop=1, size=-20, time=250, ease="easeinout_sine"},
    {"fg", file="jun_01f_00002", file1="jun_01f_00101", file2="jun_01f_00202", file4="jun_01f_00401", path=":fg/jun_01f/", id=30, ch="淳之介", lv=9, mw="mw", mode=1, sync=0, x=-5, y=-5},
    {"text"},
    text = {
      vo = { {"vo", file="08_hw01_0000", path=":vo/", ch="mob"} },
      cn = { { {"exfont", size="f4"}, name = {"淳之介", "淳之介・雏见・礼"}, "“““是海耶！！！”””", {"rt2"}, {"exfont"} } },
    },
    linknext = "0096_00005",
    line = 64,
  },
}
'''
    data = parse_ast(sample_text)
    return jsonify(data)

if __name__ == '__main__':
    app.run(debug=True, port=5000)