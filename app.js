'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const utf8 = new TextEncoder(), decoder = new TextDecoder();
  const blobs = new Map(), pending = new Map(), controllers = new Set();
  let key = null, archive = null, currentPage = '', css = '', originalScript = '';
  let generation = 0, mediaGeneration = 0, animation = null, observer = null;
  let statusTimer, navigationGeneration = 0;
  const emptyImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  async function get(url, binary = true) {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const response = await fetch(url, {signal: controller.signal, cache: 'no-cache'});
      if (!response.ok) throw new Error('Не удалось загрузить файл. Проверьте подключение.');
      return binary ? await response.arrayBuffer() : await response.json();
    } finally { controllers.delete(controller); }
  }

  async function decrypt(entry, decryptKey = key) {
    const chunks = [];
    for (const name of entry.parts) {
      const cipher = new Uint8Array(await get(name.includes('/') ? name : 'data/' + name));
      chunks.push(await crypto.subtle.decrypt({name: 'AES-GCM', iv: cipher.slice(0, 12),
        additionalData: utf8.encode(entry.aad)}, decryptKey, cipher.slice(12)));
    }
    return new Blob(chunks, {type: entry.mime});
  }

  async function file(path, playback = false) {
    const token = path + (playback ? ':playback' : '');
    if (blobs.has(token)) return blobs.get(token);
    if (pending.has(token)) return pending.get(token);
    const epoch = generation;
    const promise = (async () => {
      const record = archive?.files[path];
      if (!record) throw new Error('Вложение отсутствует в экспорте.');
      const entry = (playback && record.playback) || record;
      const blob = await decrypt(entry);
      if (epoch !== generation || !key) throw new DOMException('Locked', 'AbortError');
      const item = {blob, url: URL.createObjectURL(blob)};
      blobs.set(token, item);
      return item;
    })();
    pending.set(token, promise);
    try { return await promise; } finally { pending.delete(token); }
  }

  function status(message, duration = 4500) {
    clearTimeout(statusTimer);
    $('viewerStatus').textContent = message;
    $('viewerStatus').hidden = !message;
    if (duration) statusTimer = setTimeout(() => { $('viewerStatus').hidden = true; }, duration);
  }

  function resolvePath(value, base = currentPage) {
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return null;
    const url = new URL(value, 'https://archive.invalid/' + base);
    return {path: decodeURIComponent(url.pathname.slice(1)), hash: url.hash};
  }

  function routeHash(page, hash = '') {
    return '#' + encodeURIComponent(page) + (hash ? '/' + hash.replace(/^#/, '') : '');
  }

  function parseHash() {
    const [page, ...rest] = location.hash.slice(1).split('/');
    return {page: decodeURIComponent(page || ''), hash: rest.length ? '#' + rest.join('/') : ''};
  }

  function jump(hash) {
    if (!hash) return;
    const id = hash.replace(/^#(?:go_to_)?/, '');
    const doc = $('archiveFrame').contentDocument;
    const target = doc?.getElementById(id);
    if (!target) return status('Это сообщение отсутствует в экспорте.');
    target.scrollIntoView({block: 'center', behavior: 'smooth'});
    target.classList.add('selected');
    setTimeout(() => target.classList.remove('selected'), 1400);
  }

  async function navigate(page, hash = '', push = true) {
    if (!archive?.pages.includes(page)) return;
    if (page === currentPage && $('archiveFrame').contentDocument?.querySelector('.history')) {
      if (push) history.pushState({}, '', routeHash(page, hash));
      if (hash) jump(hash);
      else $('archiveFrame').contentWindow.scrollTo(0, 0);
      return;
    }
    const nav = ++navigationGeneration;
    status('Открываю сообщения…', 0);
    const html = await (await file(page)).blob.text();
    if (nav !== navigationGeneration || !key) return;
    observer?.disconnect();
    // Prevent a browser from fetching original relative URLs before rewriting.
    const safeHtml = html.replace(/\bsrc\s*=/gi, 'data-export-src=');
    const parsed = new DOMParser().parseFromString(safeHtml, 'text/html');
    parsed.querySelectorAll('script,link').forEach(el => el.remove());
    parsed.body.removeAttribute('onload');
    const style = parsed.createElement('style');
    style.textContent = css + '\nimg{max-width:100%;object-fit:contain}.page_wrap{min-height:100vh}.page_header .content .text{font-size:18px;padding-top:20px;padding-bottom:20px}a[data-archive-path]{cursor:pointer}.media_wrap{max-width:100%}.media_wrap .photo{max-width:100%;height:auto}.message{scroll-margin-top:80px}';
    parsed.head.append(style);
    const script = parsed.createElement('script');
    script.src = originalScript;
    parsed.head.append(script);
    for (const img of parsed.querySelectorAll('img')) {
      const source = resolvePath(img.getAttribute('data-export-src'), page);
      if (source && archive.files[source.path]) {
        img.dataset.encryptedImage = source.path;
        img.src = emptyImage;
        img.alt ||= 'Изображение из переписки';
      }
    }
    for (const anchor of parsed.querySelectorAll('a[href]')) {
      const target = resolvePath(anchor.getAttribute('href'), page);
      if (target && (archive.files[target.path] || target.hash)) {
        anchor.dataset.archivePath = target.path;
        anchor.dataset.archiveHash = target.hash;
        anchor.href = '#';
        anchor.removeAttribute('onclick');
      } else {
        const href = anchor.getAttribute('href') || '';
        if (/^(?:javascript|data|vbscript):/i.test(href.trim())) {
          anchor.removeAttribute('href');
          continue;
        }
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      }
    }
    const frame = $('archiveFrame');
    await new Promise(resolve => {
      frame.onload = resolve;
      frame.srcdoc = '<!doctype html>\n' + parsed.documentElement.outerHTML;
    });
    if (nav !== navigationGeneration || !key) return;
    currentPage = page;
    $('pageSelect').value = page;
    if (push) history.pushState({}, '', routeHash(page, hash));
    const doc = frame.contentDocument;
    doc.addEventListener('click', event => {
      const anchor = event.target.closest('a[data-archive-path]');
      if (!anchor) return;
      event.preventDefault();
      const target = anchor.dataset.archivePath;
      const hash = anchor.dataset.archiveHash;
      if (archive.pages.includes(target)) {
        // Replies may point to a message on the other exported page.
        const message = hash.replace(/^#(?:go_to_)?/, '');
        const destination = archive.messages[message] || target;
        navigate(destination, hash).catch(showError);
      } else openMedia(target).catch(showError);
    });
    observer = new frame.contentWindow.IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        observer.unobserve(img);
        file(img.dataset.encryptedImage).then(item => {
          if (img.isConnected && key) img.src = item.url;
        }).catch(error => {
          if (error.name !== 'AbortError') {
            img.alt = 'Не удалось загрузить фото — нажмите, чтобы повторить';
            img.addEventListener('click', () => file(img.dataset.encryptedImage)
              .then(item => { img.src = item.url; }).catch(showError), {once: true});
          }
        });
      }
    }, {rootMargin: '600px'});
    doc.querySelectorAll('img[data-encrypted-image]').forEach(img => observer.observe(img));
    status('');
    if (hash) setTimeout(() => jump(hash), 120);
  }

  function fileKind(path) {
    if (/\.tgs$/i.test(path)) return 'animation';
    return (archive.files[path]?.mime || '').split('/')[0];
  }

  function sizeLabel(bytes) {
    return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(bytes / 1024)) + ' КБ';
  }

  function closeMedia() {
    mediaGeneration++;
    animation?.destroy();
    animation = null;
    $('mediaBody').querySelectorAll('video,audio').forEach(el => el.pause());
    $('mediaBody').replaceChildren();
    $('downloadOriginal').removeAttribute('href');
  }

  async function openMedia(path) {
    if (!archive?.files[path]) return status('Вложение отсутствует в экспорте.');
    if ($('filesDialog').open) $('filesDialog').close();
    closeMedia();
    const epoch = mediaGeneration;
    const kind = fileKind(path), entry = archive.files[path];
    $('mediaName').textContent = path.split('/').at(-1);
    $('mediaInfo').textContent = sizeLabel(entry.size);
    $('mediaBody').textContent = 'Загружаю вложение…';
    $('downloadOriginal').textContent = 'Скачать оригинал';
    $('downloadOriginal').download = path.split('/').at(-1);
    if (!$('mediaDialog').open) $('mediaDialog').showModal();
    const playing = await file(path, !!entry.playback);
    if (epoch !== mediaGeneration || !key) return;
    $('mediaBody').replaceChildren();
    let element;
    if (kind === 'image') {
      element = document.createElement('img');
      element.alt = 'Вложение'; element.src = playing.url;
    } else if (kind === 'video' || kind === 'audio') {
      element = document.createElement(kind);
      element.controls = true; element.preload = 'metadata'; element.src = playing.url;
      if (kind === 'video') {
        element.playsInline = true;
        element.loop = /sticker/i.test(path);
      }
      element.addEventListener('error', () => {
        status('Браузер не смог воспроизвести файл. Можно скачать оригинал.');
      });
    } else if (kind === 'animation') {
      const json = await new Response(playing.blob.stream().pipeThrough(new DecompressionStream('gzip'))).json();
      if (epoch !== mediaGeneration || !key) return;
      element = document.createElement('div'); element.className = 'animation';
      $('mediaBody').append(element);
      animation = lottie.loadAnimation({container: element, renderer: 'svg', loop: true, autoplay: true, animationData: json});
    } else {
      element = document.createElement('p');
      element.textContent = 'Файл готов к скачиванию.';
    }
    if (kind !== 'animation') $('mediaBody').append(element);
    const download = $('downloadOriginal');
    // Load a potentially large original only when the visitor downloads it.
    download.href = playing.url;
    download.onclick = async event => {
      if (!entry.playback) return;
      event.preventDefault();
      download.textContent = 'Подготавливаю оригинал…';
      try {
        const original = await file(path);
        if (epoch !== mediaGeneration || !key) return;
        const link = document.createElement('a');
        link.href = original.url; link.download = path.split('/').at(-1);
        link.click();
      } catch (error) { showError(error); }
      finally { download.textContent = 'Скачать оригинал'; }
    };
  }

  function renderFiles() {
    const kind = $('fileFilter').value;
    const list = $('fileList'); list.replaceChildren();
    for (const [path, entry] of Object.entries(archive.files)) {
      if (!/^(photos|video_files|round_video_messages|voice_messages|stickers|files)\//.test(path)) continue;
      const type = fileKind(path);
      if (kind !== 'all' && kind !== type) continue;
      const button = document.createElement('button'); button.className = 'file-row';
      const icon = document.createElement('span'); icon.className = 'file-icon';
      icon.textContent = {image: '▧', video: '▶', audio: '♫', animation: '✦'}[type] || '↓';
      const text = document.createElement('span');
      const title = document.createElement('span'); title.className = 'file-title'; title.textContent = path.split('/').at(-1);
      const size = document.createElement('span'); size.className = 'file-size'; size.textContent = sizeLabel(entry.size);
      text.append(title, size); button.append(icon, text);
      button.addEventListener('click', () => openMedia(path).catch(showError));
      list.append(button);
    }
  }

  function showError(error) {
    if (error.name === 'AbortError') return;
    console.error(error);
    status(error.message || 'Не удалось открыть вложение. Попробуйте ещё раз.');
    if ($('mediaDialog').open) $('mediaBody').textContent = 'Не удалось открыть файл. Закройте окно и попробуйте снова.';
  }

  function lock() {
    generation++; navigationGeneration++;
    controllers.forEach(controller => controller.abort());
    controllers.clear(); observer?.disconnect();
    $('mediaDialog').close(); $('filesDialog').close(); closeMedia();
    $('archiveFrame').removeAttribute('srcdoc'); $('archiveFrame').src = 'about:blank';
    $('fileList').replaceChildren(); $('pageSelect').replaceChildren();
    blobs.forEach(item => URL.revokeObjectURL(item.url)); blobs.clear(); pending.clear();
    key = archive = null; css = originalScript = currentPage = '';
    $('viewer').hidden = true; $('gate').hidden = false; status('');
    $('password').value = ''; $('password').focus();
  }

  $('unlockForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('gateError').textContent = '';
    $('unlockButton').disabled = true;
    $('unlockButton').textContent = 'Открываю…';
    let unlocked = false;
    try {
      if (!crypto.subtle) throw new Error('Откройте сайт по HTTPS в современном браузере.');
      const config = await get('vault.json', false);
      const material = await crypto.subtle.importKey('raw', utf8.encode($('password').value), 'PBKDF2', false, ['deriveKey']);
      const trialKey = await crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256',
        salt: Uint8Array.from(atob(config.salt), c => c.charCodeAt(0)), iterations: config.iterations},
      material, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
      let catalogue;
      try { catalogue = await decrypt(config.catalogue, trialKey); }
      catch (error) {
        if (error.name === 'OperationError') throw new Error('Неверный пароль. Попробуйте ещё раз.');
        throw error;
      }
      archive = JSON.parse(await catalogue.text()); key = trialKey; unlocked = true;
      $('password').value = '';
      css = await (await file('css/style.css')).blob.text();
      const matches = [...css.matchAll(/url\((['"]?)([^)'"\s]+)\1\)/g)];
      const replacements = await Promise.all(matches.map(async match => {
        const target = resolvePath(match[2], 'css/style.css');
        return target && archive.files[target.path]
          ? [match[0], 'url("' + (await file(target.path)).url + '")'] : null;
      }));
      for (const replacement of replacements) if (replacement) css = css.replaceAll(...replacement);
      originalScript = (await file('js/script.js')).url;
      archive.pages.forEach((path, index) => {
        const option = document.createElement('option'); option.value = path;
        option.textContent = 'Страница ' + (index + 1) + ' / ' + archive.pages.length;
        $('pageSelect').append(option);
      });
      $('gate').hidden = true; $('viewer').hidden = false;
      const route = parseHash();
      await navigate(archive.pages.includes(route.page) ? route.page : archive.pages[0], route.hash, false);
    } catch (error) {
      if (unlocked) lock();
      $('gateError').textContent = error.message || 'Не удалось открыть архив.';
      $('password').focus();
    } finally {
      $('unlockButton').disabled = false;
      $('unlockButton').textContent = 'Открыть переписку →';
    }
  });
  $('pageSelect').addEventListener('change', () => navigate($('pageSelect').value).catch(showError));
  $('lockButton').addEventListener('click', lock);
  $('filesButton').addEventListener('click', () => { renderFiles(); $('filesDialog').showModal(); });
  $('fileFilter').addEventListener('change', renderFiles);
  $('mediaClose').addEventListener('click', () => $('mediaDialog').close());
  $('filesClose').addEventListener('click', () => $('filesDialog').close());
  $('mediaDialog').addEventListener('close', closeMedia);
  for (const id of ['mediaDialog', 'filesDialog']) $(id).addEventListener('click', event => {
    if (event.target === $(id)) {
      const box = $(id).getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $(id).close();
    }
  });
  window.addEventListener('popstate', () => {
    if (!archive) return;
    const route = parseHash();
    navigate(archive.pages.includes(route.page) ? route.page : archive.pages[0], route.hash, false).catch(showError);
  });
})();
