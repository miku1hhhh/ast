// ========== 全局状态 ==========
let sceneData = {};
let curFile = null, curScene = null, curLang = 'cn';
let isAuto = false, isMuted = false, isTTS = false;
let autoPending = null;
const expanded = new Set();
let currentBGM = null, currentVO = null;
let voVolume = 0.8, ttsVolume = 0.8, ttsRate = 0.9;
let delayTimers = [];
let fgContainers = [];

const $ = id => document.getElementById(id);
const fileList = $('file-list'), astTree = $('ast-tree'), bgLayer = $('bg-layer');
const charaSmall = $('chara-sprite');
const nameTag = $('name-tag'), dialogue = $('dialogue-text'), sceneInfo = $('scene-info');
const resourcePathInput = $('resource-path'), debugPanel = $('debug-panel');
const btnAuto = $('btnAuto'), btnTTS = $('btnTTS'), btnMute = $('btnMute');
const gameContainer = $('game-container');

window.updateVoVolume = () => { voVolume = parseInt($('voVolume').value)/100; $('voVolLabel').textContent = $('voVolume').value; };
window.updateTtsVolume = () => { ttsVolume = parseInt($('ttsVolume').value)/100; $('ttsVolLabel').textContent = $('ttsVolume').value; };
window.updateTtsRate = () => { ttsRate = parseFloat($('ttsRate').value); $('ttsRateLabel').textContent = ttsRate.toFixed(1); };

function buildBaseUrl(cmd, fileKey) {
  const base = (resourcePathInput.value||'/resources').replace(/\/+$/, '');
  const filename = cmd[fileKey] || '';
  if (cmd.path) {
    let dir = cmd.path.replace(/^:/, '').replace(/\/+$/, '');
    if (!dir.startsWith('/')) dir = '/' + dir;
    return `${base}${dir}/${filename}`;
  }
  return `${base}/${filename}`;
}
function buildAudioUrl(cmd, fileKey) { return buildBaseUrl(cmd, fileKey) + '.ogg'; }
window.testImageUrl = () => {
  const url = document.getElementById('test-url-input').value.trim();
  if (!url) return;
  const img = new Image();
  img.onload = () => alert('✅ 资源加载成功！');
  img.onerror = () => alert('❌ 资源加载失败');
  img.src = url;
};
function stopAllAudio() { if(currentVO){currentVO.pause(); currentVO=null;} if(currentBGM){currentBGM.pause(); currentBGM=null;} }
function playAudio(url, loop=false) {
  if (isMuted) return;
  const audio = new Audio(url);
  audio.loop = loop; audio.volume = voVolume;
  audio.play().catch(e=>console.warn('音频播放被阻止'));
  return audio;
}
function speakText(txt) {
  if (!window.speechSynthesis || !isTTS) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(txt);
  const langMap = { cn:'zh-CN', tw:'zh-TW', ja:'ja-JP', en:'en-US' };
  u.lang = langMap[curLang] || 'zh-CN';
  u.rate = ttsRate; u.volume = ttsVolume;
  speechSynthesis.speak(u);
}
function getText(scene, lang) {
  if (!scene || !scene.texts || scene.texts.length===0) return '';
  const block = scene.texts[0];
  if (!block) return '';
  return block[lang] || block['cn'] || block['ja'] || block['en'] || block['tw'] || '';
}
function getSpeaker(scene, lang) {
  if (!scene || !scene.texts) return '';
  const block = scene.texts[0];
  return block?.name ? (block.name[lang] || block.name['cn'] || '') : '';
}
function findNearestBg(sceneId) {
  const ids = Object.keys(sceneData).sort();
  const idx = ids.indexOf(sceneId);
  if (idx === -1) return null;
  for (let i = idx; i >= 0; i--) {
    const scene = sceneData[ids[i]];
    const allBg = (scene.commands||[]).filter(c => c.cmd === 'bg' && c.file);
    if (allBg.length > 0) return allBg[allBg.length - 1];
  }
  return null;
}
async function loadIptLayers(baseUrl, container) {
  try {
    const relPath = baseUrl.replace('/resources/', '');
    const resp = await fetch(`/api/ipt/${encodeURIComponent(relPath)}`);
    if (!resp.ok) return false;
    const data = await resp.json();
    container.innerHTML = '';
    data.layers.forEach(layer => {
      const img = document.createElement('img');
      img.src = layer.url;
      img.style.position = 'absolute';
      img.style.left = (layer.x||0)+'px';
      img.style.top = (layer.y||0)+'px';
      img.onerror = ()=>{img.style.display='none';};
      container.appendChild(img);
    });
    return true;
  } catch (e) { console.warn('IPT 加载失败', e); return false; }
}

// 获取元素当前的 transform 平移值
function getCurrentTranslation(el) {
  const style = window.getComputedStyle(el);
  const matrix = new DOMMatrixReadOnly(style.transform);
  return { x: matrix.m41, y: matrix.m42 };
}

// 移除动画并重置 transform 到基准定位
function removeAnimation(container) {
  container.classList.remove('anim-shake-down-small');
  container.style.animation = '';
  container.style.transition = '';
  container.style.removeProperty('--shake-size');
  container.style.removeProperty('--shake-duration');
  // 重置 transform 为初始定位
  if (container === charaSmall) {
    container.style.transform = '';
  } else {
    if (container.style.left === '50%' || container.style.transform.includes('translateX(-50%)')) {
      container.style.transform = 'translateX(-50%)';
    } else {
      container.style.transform = '';
    }
  }
}

function loadFgLayers(fgCmd, container, allLayers = true) {
  // 重建立绘前先清除动画并复位
  removeAnimation(container);
  container.innerHTML = '';
  if (!fgCmd || fgCmd.mode === -1) { container.classList.remove('visible'); return; }
  let layerKeys;
  if (allLayers) {
    layerKeys = Object.keys(fgCmd).filter(k => /^file\d*$/.test(k)).sort((a,b) => {
      const numA = a === 'file' ? 0 : parseInt(a.replace('file',''));
      const numB = b === 'file' ? 0 : parseInt(b.replace('file',''));
      return numA - numB;
    });
    if (layerKeys.length === 0 && fgCmd.file) layerKeys = ['file'];
  } else {
    layerKeys = ['file'].filter(k => fgCmd[k]);
    if (layerKeys.length === 0) {
      if (fgCmd.file1) layerKeys = ['file1'];
      else if (fgCmd.file2) layerKeys = ['file2'];
    }
  }
  if (layerKeys.length === 0) {
    container.innerHTML = '<div class="error-msg">无立绘文件</div>';
    container.classList.add('visible');
    return;
  }
  layerKeys.forEach(key => {
    const baseUrl = buildBaseUrl(fgCmd, key);
    const img = new Image();
    img.src = baseUrl + '.png';
    img.onerror = () => { img.src = baseUrl + '.ipt'; };
    img.style.position = 'absolute';
    img.style.top = '0'; img.style.left = '0';
    img.style.width = '100%'; img.style.height = '100%';
    img.style.objectFit = 'contain';
    img.classList.add('fade-in');
    container.appendChild(img);
  });
  container.classList.add('visible');
}

function clearDelayTimers() {
  delayTimers.forEach(t=>clearTimeout(t));
  delayTimers = [];
  fgContainers.forEach(c => removeAnimation(c));
  removeAnimation(charaSmall);
}
function findContainerById(id) {
  if (id === 30) return charaSmall;
  for (const c of fgContainers) {
    if (c.dataset.fgId === String(id)) return c;
  }
  return null;
}

// 执行单个 fgact 指令
function executeFgAct(cmd) {
  const container = findContainerById(cmd.id);
  if (!container) return;
  const act = cmd.act;
  if (act === '振動下') {
    removeAnimation(container); // 振动前先清除移动/振动，但保留当前位置？振动应该在当前位置执行。所以我们不清除 transform，只清除动画类。
    // 注意：removeAnimation 会重置 transform，我们不希望这样。所以振动单独处理，不调用 removeAnimation。
    container.classList.remove('anim-shake-down-small');
    container.style.animation = '';
    const size = Math.abs(cmd.size || 10);
    const duration = (cmd.time || 400) / 1000;
    const loop = cmd.loop || 1;
    container.style.setProperty('--shake-size', size + 'px');
    container.style.animation = `shakeDownSmall ${duration}s ease-in-out ${loop}`;
    container.classList.add('anim-shake-down-small');
    const onAnimationEnd = () => {
      container.classList.remove('anim-shake-down-small');
      container.style.animation = '';
      container.style.removeProperty('--shake-size');
      container.removeEventListener('animationend', onAnimationEnd);
    };
    container.addEventListener('animationend', onAnimationEnd);
  } else if (act === '移動' || act === '移动') {
    // 清除之前的移动过渡，但保留当前位置
    container.style.transition = '';
    const current = getCurrentTranslation(container);
    const x = Number(cmd.x) || 0;
    const y = Number(cmd.y) || 0;
    const time = Number(cmd.time) || 1000;
    const ease = cmd.ease || 'ease';
    const targetX = current.x + x;
    const targetY = current.y + y;
    // 构建新的 transform，保留基准定位
    let baseTransform = '';
    if (container.style.left === '50%' || container.style.transform.includes('translateX(-50%)')) {
      baseTransform = 'translateX(-50%)';
    }
    container.style.transition = `transform ${time}ms ${ease}`;
    container.style.transform = `${baseTransform} translate(${targetX}px, ${targetY}px)`;
    const onTransitionEnd = () => {
      container.style.transition = '';
      // 动画结束后保持最终位置
      container.style.transform = `${baseTransform} translate(${targetX}px, ${targetY}px)`;
      container.removeEventListener('transitionend', onTransitionEnd);
    };
    container.addEventListener('transitionend', onTransitionEnd);
  }
}

// delay 命令执行
function executeDelayCommand(cmd) {
  if (cmd.cmd === 'fg') {
    const container = findContainerById(cmd.id);
    if (container) {
      const allLayers = (cmd.mode !== 1 && cmd.id !== 30);
      loadFgLayers(cmd, container, allLayers);
    }
  } else if (cmd.cmd === 'fgact') {
    executeFgAct(cmd);
  }
}

function setupDelayActions(delayArray) {
  clearDelayTimers();
  if (!delayArray || delayArray.length===0) return;
  delayArray.forEach(item => {
    const timer = setTimeout(() => {
      item.commands.forEach(cmd => executeDelayCommand(cmd));
      delayTimers = delayTimers.filter(t => t !== timer);
    }, item.time);
    delayTimers.push(timer);
  });
}

function scheduleAutoAdvance() {
  if (!isAuto) return;
  if (autoPending) { clearTimeout(autoPending); autoPending = null; }
  let delay = 5000;
  if (currentVO && !currentVO.ended) {
    if (currentVO.duration && isFinite(currentVO.duration)) {
      delay = Math.ceil(currentVO.duration * 1000) + 300;
    } else {
      delay = 10000;
    }
    const onEnd = () => {
      currentVO.removeEventListener('ended', onEnd);
      if (isAuto) advance();
    };
    currentVO.addEventListener('ended', onEnd);
  }
  autoPending = setTimeout(() => { if (isAuto) advance(); }, delay);
}

async function updateGame() {
  clearDelayTimers();
  const scene = sceneData[curScene];
  if (!scene) {
    nameTag.textContent = ''; dialogue.textContent = '请选择场景';
    sceneInfo.textContent = '';
    charaSmall.innerHTML = '';
    fgContainers.forEach(c => c.remove());
    fgContainers = [];
    bgLayer.innerHTML = ''; debugPanel.style.display = 'none';
    return;
  }
  sceneInfo.textContent = `${curScene} · line ${scene.line || '?'}`;
  nameTag.textContent = getSpeaker(scene, curLang);
  dialogue.textContent = getText(scene, curLang);

  // 背景
  bgLayer.innerHTML = '';
  const allBgCmds = (scene.commands||[]).filter(c => c.cmd === 'bg' && c.file);
  let bgCmd = allBgCmds.length > 0 ? allBgCmds[allBgCmds.length - 1] : null;
  if (!bgCmd) bgCmd = findNearestBg(curScene);
  if (bgCmd) {
    const baseUrl = buildBaseUrl(bgCmd, 'file');
    const isCG = bgCmd.path && bgCmd.path.includes(':cg/');
    if (isCG) {
      const loaded = await loadIptLayers(baseUrl, bgLayer);
      if (!loaded) {
        const img = new Image();
        img.src = baseUrl + '.ipt'; img.onerror = () => { img.src = baseUrl + '.png'; };
        img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover';
        bgLayer.appendChild(img);
      }
    } else {
      const img = new Image();
      img.src = baseUrl + '.png'; img.onerror = () => { img.src = baseUrl + '.ipt'; };
      img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover';
      bgLayer.appendChild(img);
    }
  }

  // 清除所有立绘容器并重建
  charaSmall.innerHTML = '';
  fgContainers.forEach(c => c.remove());
  fgContainers = [];
  const fgCmds = (scene.commands||[]).filter(c => c.cmd === 'fg' && c.mode !== -1);
  for (const fgCmd of fgCmds) {
    const isSmall = (fgCmd.mode === 1 || fgCmd.id === 30);
    if (isSmall) {
      loadFgLayers(fgCmd, charaSmall, false);
    } else {
      const container = document.createElement('div');
      container.className = 'full-chara-container';
      container.dataset.fgId = fgCmd.id;
      const x = fgCmd.x || 0;
      container.style.bottom = (5 - (fgCmd.y || 0)) + 'px';
      if (x > 100) {
        container.style.right = '10px';
        container.style.left = 'auto';
        container.style.transform = 'none';
      } else if (x < -100) {
        container.style.left = '10px';
        container.style.right = 'auto';
        container.style.transform = 'none';
      } else {
        container.style.left = '50%';
        container.style.transform = 'translateX(-50%)';
      }
      gameContainer.appendChild(container);
      fgContainers.push(container);
      loadFgLayers(fgCmd, container, true);
    }
  }
  if (charaSmall.children.length > 0) charaSmall.classList.add('visible');
  else charaSmall.classList.remove('visible');

  // 执行初始的 fgact 指令
  const fgActCmds = (scene.commands||[]).filter(c => c.cmd === 'fgact');
  fgActCmds.forEach(cmd => executeFgAct(cmd));

  // 音频
  if (currentVO) { currentVO.pause(); currentVO = null; }
  const textBlock = scene.texts && scene.texts[0];
  let voCmd = textBlock?.vo?.[0] || (scene.commands||[]).find(c => c.cmd === 'vo' && c.file);
  if (!voCmd) {
    const seCmd = (scene.commands||[]).find(c => c.cmd === 'se' && c.file && c.path && c.path.includes(':vo/'));
    if (seCmd) voCmd = seCmd;
  }
  if (voCmd) currentVO = playAudio(buildAudioUrl(voCmd, 'file'), false);
  const bgmCmd = (scene.commands||[]).find(c => c.cmd === 'bgm' && c.file);
  if (bgmCmd) {
    if (currentBGM) { currentBGM.pause(); currentBGM = null; }
    currentBGM = playAudio(buildAudioUrl(bgmCmd, 'file'), true);
  }

  if (isTTS) { const txt = getText(scene, curLang); if (txt) speakText(txt); }
  setupDelayActions(scene.delay);
  if (isAuto) scheduleAutoAdvance();
}

function jumpScene(id) { curScene = id; updateGame(); highlightNode(id); }
window.advance = () => {
  clearDelayTimers();
  if (autoPending) { clearTimeout(autoPending); autoPending = null; }
  if (!curScene || !sceneData[curScene]) return;
  const scene = sceneData[curScene];
  if (scene.linknext && sceneData[scene.linknext]) {
    curScene = scene.linknext;
    updateGame();
    highlightNode(curScene);
  }
  if (isAuto) scheduleAutoAdvance();
};
window.prevScene = () => {
  if (!curScene || !sceneData[curScene]) return;
  const scene = sceneData[curScene];
  if (scene.linkback && sceneData[scene.linkback]) jumpScene(scene.linkback);
};

// 文件加载、AST 渲染等函数保持不变（与之前相同，略）

// 文件加载、AST渲染等函数保持不变（略，同前）

async function loadFileList() {
  const res = await fetch('/api/files');
  const files = await res.json();
  fileList.innerHTML = '';
  files.forEach(f => {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `📄 ${f}`;
    div.onclick = () => loadFile(f);
    fileList.appendChild(div);
  });
}
async function loadFile(filename) {
  try {
    stopAllAudio();
    const res = await fetch(`/api/parse/${encodeURIComponent(filename)}`);
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || '解析失败'); }
    const data = await res.json();
    sceneData = data.scenes || {};
    renderAST();
    const first = Object.keys(sceneData)[0];
    if (first) jumpScene(first);
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    [...fileList.children].find(el => el.textContent.includes(filename))?.classList.add('active');
  } catch (e) { alert('无法加载文件: ' + e.message); }
}
async function loadSample() {
  stopAllAudio();
  const res = await fetch('/api/sample');
  const data = await res.json();
  sceneData = data.scenes || {};
  renderAST();
  const first = Object.keys(sceneData)[0];
  if (first) jumpScene(first);
}
document.getElementById('fileUpload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  await fetch('/api/upload', { method: 'POST', body: form });
  loadFileList();
});

function renderAST() {
  astTree.innerHTML = '';
  if (!sceneData || Object.keys(sceneData).length === 0) {
    astTree.innerHTML = '<div style="padding:10px;color:#888;">暂无场景数据</div>';
    return;
  }
  for (const [id, scene] of Object.entries(sceneData)) {
    const node = document.createElement('div');
    node.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'node-row';
    row.dataset.scene = id;
    row.innerHTML = `<span class="node-toggle">▶</span><span class="node-icon scene">S</span><span class="node-label">${id}</span>`;
    row.onclick = (e) => { e.stopPropagation(); jumpScene(id); toggleNode(node); };
    const children = document.createElement('div');
    children.className = 'node-children collapsed';
    if (expanded.has(id)) children.classList.remove('collapsed');
    (scene.commands||[]).forEach(c => {
      const cr = document.createElement('div');
      cr.className = 'node-row';
      cr.innerHTML = `<span class="node-toggle" style="visibility:hidden">▶</span><span class="node-icon cmd">C</span><span class="node-label">${c.cmd}</span>`;
      children.appendChild(cr);
    });
    (scene.texts||[]).forEach((t,i) => {
      const tr = document.createElement('div');
      tr.className = 'node-row';
      const preview = (t.cn || t.ja || t.en || '').substring(0, 20);
      tr.innerHTML = `<span class="node-toggle" style="visibility:hidden">▶</span><span class="node-icon txt">T</span><span class="node-label">${preview || '...'}</span>`;
      children.appendChild(tr);
    });
    if (scene.linknext || scene.linkback) {
      const lr = document.createElement('div');
      lr.className = 'node-row';
      lr.innerHTML = `<span class="node-toggle" style="visibility:hidden">▶</span><span class="node-icon link">L</span><span class="node-label">next:${scene.linknext||'?'} back:${scene.linkback||'?'}</span>`;
      children.appendChild(lr);
    }
    node.appendChild(row); node.appendChild(children);
    astTree.appendChild(node);
  }
}
function toggleNode(nodeDiv) {
  const ch = nodeDiv.querySelector('.node-children');
  ch.classList.toggle('collapsed');
  const id = nodeDiv.querySelector('.node-row').dataset.scene;
  if (ch.classList.contains('collapsed')) expanded.delete(id);
  else expanded.add(id);
  const tg = nodeDiv.querySelector('.node-toggle');
  tg.textContent = ch.classList.contains('collapsed') ? '▶' : '▼';
}
function highlightNode(sceneId) {
  document.querySelectorAll('.node-row').forEach(r => r.classList.remove('active'));
  const row = document.querySelector(`.node-row[data-scene="${sceneId}"]`);
  if (row) { row.classList.add('active'); row.scrollIntoView({block:'center', behavior:'smooth'}); }
}

window.toggleAuto = function() {
  isAuto = !isAuto; btnAuto.classList.toggle('on', isAuto);
  if (isAuto) { scheduleAutoAdvance(); }
  else { if (autoPending) { clearTimeout(autoPending); autoPending = null; } }
};
window.toggleTTS = function() {
  isTTS = !isTTS; btnTTS.classList.toggle('on', isTTS);
  if (isTTS) { const scene = sceneData[curScene]; if (scene) { const txt = getText(scene, curLang); if (txt) speakText(txt); } }
  else { window.speechSynthesis?.cancel(); }
};
window.toggleMute = function() { isMuted = !isMuted; btnMute.classList.toggle('on', isMuted); if (isMuted) stopAllAudio(); };

document.querySelectorAll('#lang-bar button').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('#lang-bar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    curLang = btn.dataset.lang;
    updateGame();
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); advance(); }
  if (e.key === 'ArrowRight') advance();
  if (e.key === 'ArrowLeft') prevScene();
});
document.getElementById('btnSample').addEventListener('click', loadSample);
resourcePathInput.addEventListener('input', updateGame);
updateVoVolume(); updateTtsVolume(); updateTtsRate();
loadFileList();
loadSample();