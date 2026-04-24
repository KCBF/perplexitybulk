// ==UserScript==
// @name         Devpost Project Extractor
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Extract a Devpost project page into structured Markdown, bundle all images + external video links into a single ZIP download
// @author       You
// @match        *://devpost.com/software/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ---------- UI ----------
    function injectUI() {
        const btn = document.createElement('button');
        btn.id = 'dp-extract-btn';
        btn.innerText = '📦 Export Devpost';
        btn.style.cssText = `
            position: fixed; bottom: 24px; right: 24px; z-index: 99999;
            padding: 12px 18px; border-radius: 10px; border: none;
            background: #003E54; color: #fff; font-weight: 600;
            font-family: system-ui, sans-serif; cursor: pointer;
            box-shadow: 0 6px 18px rgba(0,0,0,.25);
        `;
        const status = document.createElement('div');
        status.id = 'dp-extract-status';
        status.style.cssText = `
            position: fixed; bottom: 74px; right: 24px; z-index: 99999;
            max-width: 320px; padding: 8px 12px; border-radius: 8px;
            background: #111; color: #0f0; font: 12px/1.4 monospace;
            display: none; white-space: pre-wrap;
        `;
        btn.onclick = () => run(status, btn);
        document.body.appendChild(btn);
        document.body.appendChild(status);
    }

    function log(statusEl, msg) {
        statusEl.style.display = 'block';
        statusEl.textContent = msg;
        console.log('[Devpost Export]', msg);
    }

    // ---------- Helpers ----------
    const slugify = (s) => (s || 'devpost').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

    function absUrl(u) {
        try { return new URL(u, location.href).href; } catch { return u; }
    }

    function extForUrl(url, fallback = 'jpg') {
        const clean = url.split('?')[0].split('#')[0];
        const m = clean.match(/\.([a-zA-Z0-9]{2,5})$/);
        if (m) return m[1].toLowerCase();
        return fallback;
    }

    function gmFetchBinary(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) resolve(r.response);
                    else reject(new Error('HTTP ' + r.status));
                },
                onerror: (e) => reject(e),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    // ---------- Minimal STORE-only ZIP writer (fallback when JSZip hangs) ----------
    // CRC32 table
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[i] = c >>> 0;
        }
        return t;
    })();
    function crc32(u8) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function strToU8(s) { return new TextEncoder().encode(s); }

    function buildZip(files) {
        const records = files.map(f => {
            const nameBytes = strToU8(f.name);
            const crc = crc32(f.data);
            return { nameBytes, data: f.data, crc, size: f.data.length };
        });
        // Build local file headers + data + central directory
        const chunks = [];
        const central = [];
        let offset = 0;
        for (const r of records) {
            const lh = new Uint8Array(30 + r.nameBytes.length);
            const dv = new DataView(lh.buffer);
            dv.setUint32(0, 0x04034b50, true);    // local file header sig
            dv.setUint16(4, 20, true);            // version
            dv.setUint16(6, 0, true);             // flags
            dv.setUint16(8, 0, true);             // method (0 = STORE)
            dv.setUint16(10, 0, true);            // mod time
            dv.setUint16(12, 0, true);            // mod date
            dv.setUint32(14, r.crc, true);
            dv.setUint32(18, r.size, true);       // comp size
            dv.setUint32(22, r.size, true);       // uncomp size
            dv.setUint16(26, r.nameBytes.length, true);
            dv.setUint16(28, 0, true);            // extra len
            lh.set(r.nameBytes, 30);
            chunks.push(lh, r.data);
            // central dir entry
            const cd = new Uint8Array(46 + r.nameBytes.length);
            const cdv = new DataView(cd.buffer);
            cdv.setUint32(0, 0x02014b50, true);
            cdv.setUint16(4, 20, true);  cdv.setUint16(6, 20, true);
            cdv.setUint16(8, 0, true);   cdv.setUint16(10, 0, true);
            cdv.setUint16(12, 0, true);  cdv.setUint16(14, 0, true);
            cdv.setUint32(16, r.crc, true);
            cdv.setUint32(20, r.size, true);
            cdv.setUint32(24, r.size, true);
            cdv.setUint16(28, r.nameBytes.length, true);
            cdv.setUint16(30, 0, true);  cdv.setUint16(32, 0, true);
            cdv.setUint16(34, 0, true);  cdv.setUint16(36, 0, true);
            cdv.setUint32(38, 0, true);
            cdv.setUint32(42, offset, true);
            cd.set(r.nameBytes, 46);
            central.push(cd);
            offset += lh.length + r.data.length;
        }
        const cdStart = offset;
        let cdSize = 0;
        for (const c of central) { chunks.push(c); cdSize += c.length; }
        const eocd = new Uint8Array(22);
        const edv = new DataView(eocd.buffer);
        edv.setUint32(0, 0x06054b50, true);
        edv.setUint16(4, 0, true); edv.setUint16(6, 0, true);
        edv.setUint16(8, records.length, true);
        edv.setUint16(10, records.length, true);
        edv.setUint32(12, cdSize, true);
        edv.setUint32(16, cdStart, true);
        edv.setUint16(20, 0, true);
        chunks.push(eocd);
        return new Blob(chunks, { type: 'application/zip' });
    }

    // Detect YouTube/Vimeo/etc. from an embed URL
    function normalizeVideoUrl(src) {
        if (!src) return null;
        const u = absUrl(src);
        // youtube
        let m = u.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
        if (m) return { kind: 'YouTube', url: `https://www.youtube.com/watch?v=${m[1]}`, id: m[1] };
        m = u.match(/youtube\.com\/watch\?v=([A-Za-z0-9_-]{6,})/);
        if (m) return { kind: 'YouTube', url: u, id: m[1] };
        // vimeo
        m = u.match(/player\.vimeo\.com\/video\/(\d+)/);
        if (m) return { kind: 'Vimeo', url: `https://vimeo.com/${m[1]}`, id: m[1] };
        m = u.match(/vimeo\.com\/(\d+)/);
        if (m) return { kind: 'Vimeo', url: u, id: m[1] };
        return { kind: 'Video', url: u };
    }

    // ---------- HTML -> Markdown (lightweight, tuned for Devpost content blocks) ----------
    function mdEscape(s) {
        return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    }

    function htmlToMarkdown(root, imageMap, videoList) {
        const lines = [];
        let listDepth = 0;

        function walk(node, prefix = '') {
            if (node.nodeType === Node.TEXT_NODE) {
                const t = node.textContent.replace(/\s+/g, ' ');
                if (t.trim()) lines.push({ inline: true, text: t });
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            const tag = node.tagName.toLowerCase();

            // Skip script/style
            if (['script', 'style', 'noscript'].includes(tag)) return;

            // iframes -> video links
            if (tag === 'iframe') {
                const v = normalizeVideoUrl(node.src);
                if (v) {
                    videoList.push(v);
                    pushBlock(`\n**[${v.kind} video]** ${v.url}\n`);
                }
                return;
            }

            if (tag === 'img') {
                const src = node.getAttribute('data-src') || node.getAttribute('src');
                if (!src) return;
                const abs = absUrl(src);
                const alt = node.getAttribute('alt') || '';
                const rel = imageMap.register(abs);
                pushBlock(`\n![${alt}](${rel})\n`);
                return;
            }

            if (tag === 'a') {
                const href = node.getAttribute('href');
                const text = node.textContent.trim();
                if (!href) { walkChildren(node); return; }
                // Detect youtube/video links in content
                if (/youtube\.com|youtu\.be|vimeo\.com/i.test(href)) {
                    const v = normalizeVideoUrl(href);
                    if (v) videoList.push(v);
                }
                lines.push({ inline: true, text: `[${text || href}](${absUrl(href)})` });
                return;
            }

            if (tag === 'br') { lines.push({ inline: true, text: '\n' }); return; }

            if (/^h[1-6]$/.test(tag)) {
                const level = Math.min(6, parseInt(tag[1], 10) + 1); // bump so page H1 stays H1
                flushInline();
                const text = node.textContent.trim();
                if (text) lines.push({ block: true, text: `\n${'#'.repeat(level)} ${text}\n` });
                return;
            }

            if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
                flushInline();
                walkChildren(node);
                flushInline();
                lines.push({ block: true, text: '\n' });
                return;
            }

            if (tag === 'strong' || tag === 'b') {
                lines.push({ inline: true, text: `**${node.textContent.trim()}**` });
                return;
            }
            if (tag === 'em' || tag === 'i') {
                lines.push({ inline: true, text: `*${node.textContent.trim()}*` });
                return;
            }
            if (tag === 'code') {
                lines.push({ inline: true, text: '`' + node.textContent + '`' });
                return;
            }
            if (tag === 'pre') {
                flushInline();
                lines.push({ block: true, text: '\n```\n' + node.textContent.replace(/\n$/, '') + '\n```\n' });
                return;
            }
            if (tag === 'blockquote') {
                flushInline();
                const txt = node.textContent.trim().split('\n').map(l => '> ' + l).join('\n');
                lines.push({ block: true, text: '\n' + txt + '\n' });
                return;
            }
            if (tag === 'ul' || tag === 'ol') {
                flushInline();
                listDepth++;
                [...node.children].forEach((li, i) => {
                    if (li.tagName.toLowerCase() !== 'li') return;
                    const bullet = tag === 'ol' ? `${i + 1}.` : '-';
                    const indent = '  '.repeat(listDepth - 1);
                    const inner = renderInline(li);
                    lines.push({ block: true, text: `${indent}${bullet} ${inner}` });
                });
                listDepth--;
                lines.push({ block: true, text: '' });
                return;
            }

            walkChildren(node);
        }

        function walkChildren(node) {
            node.childNodes.forEach(c => walk(c));
        }

        function pushBlock(text) {
            flushInline();
            lines.push({ block: true, text });
        }

        let inlineBuf = '';
        function flushInline() {
            if (inlineBuf.trim()) {
                lines.push({ block: true, text: inlineBuf.trim() });
            }
            inlineBuf = '';
        }

        // pseudo-render for list items
        function renderInline(el) {
            const parts = [];
            el.childNodes.forEach(n => {
                if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent.replace(/\s+/g, ' '));
                else if (n.nodeType === Node.ELEMENT_NODE) {
                    const t = n.tagName.toLowerCase();
                    if (t === 'a') {
                        const href = n.getAttribute('href');
                        if (href && /youtube\.com|youtu\.be|vimeo\.com/i.test(href)) {
                            const v = normalizeVideoUrl(href); if (v) videoList.push(v);
                        }
                        parts.push(`[${n.textContent.trim()}](${absUrl(href || '')})`);
                    } else if (t === 'img') {
                        const src = n.getAttribute('data-src') || n.getAttribute('src');
                        if (src) {
                            const rel = imageMap.register(absUrl(src));
                            parts.push(`![${n.getAttribute('alt') || ''}](${rel})`);
                        }
                    } else if (t === 'strong' || t === 'b') parts.push(`**${n.textContent.trim()}**`);
                    else if (t === 'em' || t === 'i') parts.push(`*${n.textContent.trim()}*`);
                    else parts.push(n.textContent.replace(/\s+/g, ' '));
                }
            });
            return parts.join('').trim();
        }

        // Drive it
        const out = [];
        function collectInline(node, buf) {
            node.childNodes.forEach(c => {
                if (c.nodeType === Node.TEXT_NODE) buf.push(c.textContent);
                else if (c.nodeType === Node.ELEMENT_NODE) {
                    const t = c.tagName.toLowerCase();
                    if (['strong','b'].includes(t)) buf.push(`**${c.textContent.trim()}**`);
                    else if (['em','i'].includes(t)) buf.push(`*${c.textContent.trim()}*`);
                    else if (t === 'a') {
                        const href = c.getAttribute('href') || '';
                        if (/youtube\.com|youtu\.be|vimeo\.com/i.test(href)) {
                            const v = normalizeVideoUrl(href); if (v) videoList.push(v);
                        }
                        buf.push(`[${c.textContent.trim()}](${absUrl(href)})`);
                    }
                    else if (t === 'br') buf.push('\n');
                    else collectInline(c, buf);
                }
            });
        }

        function renderBlock(el) {
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            if (!tag) return;
            if (['script','style','noscript'].includes(tag)) return;

            if (/^h[1-6]$/.test(tag)) {
                const level = Math.min(6, parseInt(tag[1], 10) + 1);
                const text = el.textContent.trim();
                if (text) out.push(`\n${'#'.repeat(level)} ${text}\n`);
                return;
            }
            if (tag === 'ul' || tag === 'ol') {
                [...el.children].forEach((li, i) => {
                    if (li.tagName.toLowerCase() !== 'li') return;
                    const buf = [];
                    collectInline(li, buf);
                    // handle nested lists
                    const nested = [...li.children].filter(c => ['ul','ol'].includes(c.tagName.toLowerCase()));
                    const bullet = tag === 'ol' ? `${i + 1}.` : '-';
                    out.push(`${bullet} ${buf.join('').trim()}`);
                    nested.forEach(n => {
                        [...n.children].forEach((sub, j) => {
                            const sbuf = [];
                            collectInline(sub, sbuf);
                            const sb = n.tagName.toLowerCase() === 'ol' ? `${j+1}.` : '-';
                            out.push(`  ${sb} ${sbuf.join('').trim()}`);
                        });
                    });
                });
                out.push('');
                return;
            }
            if (tag === 'blockquote') {
                const txt = el.textContent.trim().split('\n').map(l => '> ' + l).join('\n');
                out.push('\n' + txt + '\n');
                return;
            }
            if (tag === 'pre') {
                out.push('\n```\n' + el.textContent.replace(/\n$/, '') + '\n```\n');
                return;
            }
            if (tag === 'iframe') {
                const v = normalizeVideoUrl(el.src);
                if (v) { videoList.push(v); out.push(`\n**[${v.kind} video]** ${v.url}\n`); }
                return;
            }
            if (tag === 'img') {
                const src = el.getAttribute('data-src') || el.getAttribute('src');
                if (src) {
                    const rel = imageMap.register(absUrl(src));
                    out.push(`\n![${el.getAttribute('alt') || ''}](${rel})\n`);
                }
                return;
            }
            if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
                // Render children: blocks recursively, collect inline runs
                const children = [...el.childNodes];
                const blockTags = new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','ul','ol','blockquote','pre','iframe','img','table']);
                let inlineRun = [];
                const flushRun = () => {
                    if (inlineRun.length) {
                        const buf = [];
                        inlineRun.forEach(n => {
                            if (n.nodeType === Node.TEXT_NODE) buf.push(n.textContent);
                            else collectInline(n, buf);
                        });
                        const t = buf.join('').replace(/[ \t]+/g, ' ').trim();
                        if (t) out.push(t + '\n');
                        inlineRun = [];
                    }
                };
                children.forEach(c => {
                    if (c.nodeType === Node.ELEMENT_NODE && blockTags.has(c.tagName.toLowerCase())) {
                        flushRun();
                        renderBlock(c);
                    } else {
                        inlineRun.push(c);
                    }
                });
                flushRun();
                return;
            }
            if (tag === 'table') {
                // simple table
                const rows = [...el.querySelectorAll('tr')];
                if (!rows.length) return;
                const cells = (r, sel) => [...r.querySelectorAll(sel)].map(c => mdEscape(c.textContent.trim().replace(/\n/g,' ')));
                const headerCells = cells(rows[0], 'th,td');
                out.push('| ' + headerCells.join(' | ') + ' |');
                out.push('| ' + headerCells.map(() => '---').join(' | ') + ' |');
                rows.slice(1).forEach(r => {
                    const cs = cells(r, 'td,th');
                    if (cs.length) out.push('| ' + cs.join(' | ') + ' |');
                });
                out.push('');
                return;
            }
            // default: recurse
            [...el.children].forEach(renderBlock);
        }

        [...root.children].forEach(renderBlock);
        // Also handle bare text inside root
        return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    // ---------- Image name registry ----------
    function createImageMap() {
        const map = new Map(); // url -> filename
        let i = 0;
        return {
            register(url) {
                if (map.has(url)) return 'images/' + map.get(url);
                i++;
                const ext = extForUrl(url, 'jpg');
                const name = `img-${String(i).padStart(3,'0')}.${ext}`;
                map.set(url, name);
                return 'images/' + name;
            },
            all() { return [...map.entries()]; },
        };
    }

    // ---------- Extraction ----------
    function extract() {
        const imageMap = createImageMap();
        const videoList = [];

        const title =
            document.querySelector('#app-details h1')?.textContent.trim() ||
            document.querySelector('#software-header h1')?.textContent.trim() ||
            document.querySelector('h1')?.textContent.trim() ||
            document.title;

        const tagline =
            document.querySelector('#app-details p.large')?.textContent.trim() ||
            document.querySelector('.software-tagline')?.textContent.trim() ||
            document.querySelector('header .large')?.textContent.trim() || '';

        // Main body
        const body = document.querySelector('#app-details-left') || document.querySelector('#app-details') || document.body;

        // Gallery images
        const galleryImgs = [...document.querySelectorAll('#gallery img, .software-gallery img, [id*="gallery"] img')];
        galleryImgs.forEach(img => {
            const src = img.getAttribute('data-src') || img.getAttribute('src');
            if (src) imageMap.register(absUrl(src));
        });

        // Gallery iframes (videos)
        [...document.querySelectorAll('#gallery iframe, .software-gallery iframe, [id*="gallery"] iframe')].forEach(f => {
            const v = normalizeVideoUrl(f.src);
            if (v) videoList.push(v);
        });

        // Built With
        const builtWith = [...document.querySelectorAll('#built-with li, .cp-tag, [id*="built-with"] li')]
            .map(el => el.textContent.trim()).filter(Boolean);

        // Links (Try it out, GitHub, etc.)
        const sideLinks = [...document.querySelectorAll('#app-details-left ul.no-bullet a, nav.app-links a, .app-links a')]
            .map(a => ({ text: a.textContent.trim(), href: a.href }))
            .filter(l => l.href && !l.href.includes('javascript:'));

        // Team
        const team = [...document.querySelectorAll('.software-team-member, .team-member')]
            .map(el => {
                const name = el.querySelector('.user-profile-link, a')?.textContent.trim() || el.textContent.trim();
                const href = el.querySelector('a')?.href || '';
                return { name, href };
            }).filter(t => t.name);

        // Meta (likes, winner badges)
        const likes = document.querySelector('.software-likes .side-count, [class*="like"] .side-count')?.textContent.trim() || '';

        // Build markdown
        const md = [];
        md.push(`# ${title}`);
        if (tagline) md.push(`\n> ${tagline}\n`);
        md.push(`\n*Source:* <${location.href}>\n`);

        // Main content body (converted)
        const bodyMd = htmlToMarkdown(body, imageMap, videoList);
        if (bodyMd) md.push('\n' + bodyMd + '\n');

        if (builtWith.length) {
            md.push('\n## Built With\n');
            md.push(builtWith.map(b => `- ${b}`).join('\n'));
        }

        if (sideLinks.length) {
            md.push('\n## Links\n');
            md.push(sideLinks.map(l => `- [${l.text}](${l.href})`).join('\n'));
        }

        if (team.length) {
            md.push('\n## Team\n');
            md.push(team.map(t => t.href ? `- [${t.name}](${t.href})` : `- ${t.name}`).join('\n'));
        }

        // Dedup videos
        const seen = new Set();
        const videos = videoList.filter(v => {
            const k = v.url; if (seen.has(k)) return false; seen.add(k); return true;
        });
        if (videos.length) {
            md.push('\n## Videos / External Media\n');
            md.push(videos.map(v => `- **${v.kind}**: ${v.url}`).join('\n'));
        }

        if (likes) md.push(`\n---\n\n*Likes:* ${likes}\n`);

        return {
            title,
            slug: slugify(title),
            markdown: md.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n',
            images: imageMap.all(),  // [ [url, name] ]
            videos,
        };
    }

    // ---------- Runner ----------
    async function run(statusEl, btn) {
        btn.disabled = true;
        const oldText = btn.innerText;
        try {
            log(statusEl, 'Extracting page...');
            const data = extract();

            log(statusEl, `Found ${data.images.length} images, ${data.videos.length} videos. Downloading images...`);

            const base = data.slug;
            const files = []; // { name, data: Uint8Array }
            files.push({ name: `${base}/README.md`, data: strToU8(data.markdown) });

            if (data.videos.length) {
                const lines = data.videos.map(v => `[${v.kind}] ${v.url}`).join('\n');
                files.push({ name: `${base}/videos.txt`, data: strToU8(lines + '\n') });
            }

            let done = 0, failed = 0;
            const failures = [];

            for (const [url, name] of data.images) {
                try {
                    const buf = await gmFetchBinary(url);
                    files.push({ name: `${base}/images/${name}`, data: new Uint8Array(buf) });
                    done++;
                } catch (e) {
                    failed++;
                    failures.push(`${name}\t${url}\t${e.message || e}`);
                }
                log(statusEl, `Images: ${done + failed}/${data.images.length} (${failed} failed)`);
            }

            if (failures.length) {
                files.push({ name: `${base}/image-failures.txt`, data: strToU8(failures.join('\n') + '\n') });
            }

            log(statusEl, `Zipping ${files.length} files...`);
            const blob = buildZip(files);

            log(statusEl, `Zip ready (${(blob.size / 1024 / 1024).toFixed(2)} MB). Triggering download...`);

            // Primary: direct anchor click (works even when FileSaver's saveAs is sandboxed)
            try {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${data.slug}.zip`;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    a.remove();
                    URL.revokeObjectURL(url);
                }, 2000);
            } catch (e) {
                throw new Error('Download failed: ' + (e.message || e));
            }

            log(statusEl, `Done! ${done} images, ${data.videos.length} videos.\nSaved ${data.slug}.zip`);
        } catch (e) {
            console.error(e);
            log(statusEl, 'Error: ' + (e.message || e));
        } finally {
            btn.disabled = false;
            btn.innerText = oldText;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectUI);
    } else {
        injectUI();
    }
})();
