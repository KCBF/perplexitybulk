// ==UserScript==
// @name         Perplexity Batch Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Batch download all Perplexity chats as Markdown files in a ZIP archive
// @author       You
// @match        *://www.perplexity.ai/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- IFRAME SCRIPT ---
    // If we are running inside the batch iframe, intercept fetch API
    if (window.self !== window.top) {
        if (window.name === 'pplx-batch-iframe') {
            const _fetch = window.fetch;
            window.fetch = async function (...args) {
                const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url ? args[0].url : '');
                const response = await _fetch.apply(this, args);

                // Intercept the API request that fetches the thread content
                if (url.includes('/rest/thread/') && !url.includes('list_ask_threads')) {
                    try {
                        const data = await response.clone().json();
                        const currentSlug = location.pathname.split('/').pop();
                        window.parent.postMessage({
                            type: 'PPLX_BATCH_DATA',
                            slug: currentSlug,
                            data: data
                        }, '*');
                    } catch (e) {
                        console.error("Error parsing intercepted thread data:", e);
                    }
                }
                return response;
            };

            // Add a fallback in case the API doesn't fire
            window.addEventListener('load', () => {
                setTimeout(() => {
                    const currentSlug = location.pathname.split('/').pop();
                    window.parent.postMessage({
                        type: 'PPLX_BATCH_TIMEOUT',
                        slug: currentSlug
                    }, '*');
                }, 10000); // 10s fallback
            });
        }
        return; // Do not render UI in iframe
    }

    // --- MAIN WINDOW SCRIPT ---

    let uiInjected = false;

    // Inject UI on load
    window.addEventListener('load', () => {
        if (!uiInjected) injectUI();
    });

    // Fallback if load already fired before this script
    if (document.readyState === 'complete') {
        setTimeout(() => { if (!uiInjected) injectUI(); }, 1000);
    }

    function injectUI() {
        uiInjected = true;
        const btn = document.createElement('button');
        btn.innerText = '📦 Batch Download';
        btn.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 9999;
            padding: 12px 20px;
            background: #202020;
            color: #ffffff;
            border: 1px solid #404040;
            border-radius: 8px;
            font-family: system-ui, -apple-system, sans-serif;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            box-shadow: 0 8px 24px rgba(0,0,0,0.2);
            transition: all 0.2s ease;
        `;
        btn.onmouseover = () => btn.style.transform = 'scale(1.05)';
        btn.onmouseout = () => btn.style.transform = 'scale(1)';
        btn.onclick = openModal;
        document.body.appendChild(btn);
    }

    function openModal() {
        if (document.getElementById('pplx-batch-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'pplx-batch-modal';
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 600px; max-width: 90vw; height: 600px; max-height: 90vh;
            background: #191919; color: #fff; border: 1px solid #333; border-radius: 12px;
            z-index: 10000; box-shadow: 0 20px 50px rgba(0,0,0,0.5);
            display: flex; flex-direction: column; font-family: system-ui, -apple-system, sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px 24px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; background: #222; border-radius: 12px 12px 0 0;';
        header.innerHTML = `<h2 style="margin: 0; font-size: 18px; font-weight: 600; display:flex; align-items:center; gap:8px;">📦 Download Perplexity Chats</h2>`;

        const closeBtn = document.createElement('button');
        closeBtn.innerText = '✕';
        closeBtn.style.cssText = 'background: transparent; border: none; color: #888; font-size: 18px; cursor: pointer; transition: color 0.1s;';
        closeBtn.onmouseover = () => closeBtn.style.color = '#fff';
        closeBtn.onmouseout = () => closeBtn.style.color = '#888';
        closeBtn.onclick = () => modal.remove();
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.style.cssText = 'flex: 1; padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;';

        const fetchBtn = document.createElement('button');
        fetchBtn.innerText = '1. Fetch List of Subscribed Chats';
        fetchBtn.style.cssText = 'padding: 14px; background: #007aff; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 15px; transition: background 0.2s;';
        fetchBtn.onmouseover = () => fetchBtn.style.background = '#005fdf';
        fetchBtn.onmouseout = () => fetchBtn.style.background = '#007aff';


        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'background: #252525; border: 1px solid #444; border-radius: 8px; flex: 1; overflow-y: auto; padding: 12px; display: none;';

        const footer = document.createElement('div');
        footer.style.cssText = 'padding: 16px 24px; border-top: 1px solid #333; display: flex; justify-content: space-between; align-items:center; background: #222; border-radius: 0 0 12px 12px;';

        const statusLabel = document.createElement('div');
        statusLabel.style.cssText = 'font-size: 14px; color: #aaa;';
        statusLabel.innerText = 'Ready';

        const dlBtn = document.createElement('button');
        dlBtn.innerText = '2. Download Selected as ZIP';
        dlBtn.style.cssText = 'padding: 12px 20px; background: #28a745; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; opacity: 0.5; pointer-events: none; transition: all 0.2s;';

        let allChatsMap = new Map();

        fetchBtn.onclick = async () => {
            fetchBtn.innerText = 'Fetching Library... Please wait.';
            fetchBtn.style.opacity = '0.7';
            fetchBtn.style.pointerEvents = 'none';
            listContainer.style.display = 'flex';
            listContainer.style.flexDirection = 'column';
            listContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Contacting API...</div>';

            try {
                let all = [];
                let offset = 0;
                while (true) {
                    const res = await fetch('/rest/thread/list_ask_threads?source=default', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ limit: 50, ascending: false, offset: offset, search_term: '' })
                    });

                    if (!res.ok) throw new Error("API returned " + res.status);

                    const data = await res.json();
                    if (!Array.isArray(data) || data.length === 0) break;

                    all.push(...data);
                    offset += 50;
                    listContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: #007aff;">Found ${all.length} chats so far...</div>`;

                    if (data.length < 50) break; // Finished pagination
                }

                listContainer.innerHTML = '';

                // Header Select All
                const selectAllDiv = document.createElement('div');
                selectAllDiv.style.cssText = 'padding: 8px 12px; background: #333; border-radius: 6px; margin-bottom: 12px; font-weight: bold;';
                selectAllDiv.innerHTML = `<label style="display:flex; gap: 8px; cursor: pointer;"><input type="checkbox" id="pplx-select-all" checked> Select All (${all.length} total)</label>`;
                listContainer.appendChild(selectAllDiv);

                const itemsDiv = document.createElement('div');
                itemsDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
                listContainer.appendChild(itemsDiv);

                allChatsMap.clear();
                all.forEach(chat => {
                    if (!chat.slug) return;
                    allChatsMap.set(chat.slug, chat);

                    const div = document.createElement('label');
                    div.style.cssText = 'padding: 8px 12px; display: flex; gap: 12px; align-items: center; border-bottom: 1px solid #383838; cursor: pointer; transition: background 0.1s; border-radius: 4px;';
                    div.onmouseover = () => div.style.background = '#383838';
                    div.onmouseout = () => div.style.background = 'transparent';

                    const dateStr = chat.last_query_datetime ? new Date(chat.last_query_datetime).toLocaleDateString() : '';
                    div.innerHTML = `
                        <input type="checkbox" class="pplx-chat-cb" value="${chat.slug}" checked>
                        <div style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; color: #eee;">${chat.title || 'Untitled'}</div>
                        <div style="font-size: 12px; color: #888; white-space: nowrap;">${dateStr}</div>
                    `;
                    itemsDiv.appendChild(div);
                });

                document.getElementById('pplx-select-all').onchange = (e) => {
                    const checked = e.target.checked;
                    document.querySelectorAll('.pplx-chat-cb').forEach(cb => cb.checked = checked);
                };

                fetchBtn.style.display = 'none';
                dlBtn.style.opacity = '1';
                dlBtn.style.pointerEvents = 'auto';
                statusLabel.innerText = "Select chats to backup & click Download.";

            } catch (e) {
                listContainer.innerHTML = `<div style="color: coral; padding: 20px;">Error: ${e.message}</div>`;
                fetchBtn.innerText = 'Fetch Failed - Retry?';
                fetchBtn.style.opacity = '1';
                fetchBtn.style.pointerEvents = 'auto';
            }
        };

        let isExporting = false;
        dlBtn.onclick = async () => {
            if (isExporting) return;
            const selectedCbs = Array.from(document.querySelectorAll('.pplx-chat-cb')).filter(cb => cb.checked);
            if (!selectedCbs.length) {
                alert('Select at least one chat!');
                return;
            }

            isExporting = true;
            dlBtn.style.opacity = '0.7';
            dlBtn.style.pointerEvents = 'none';

            // JSZip requires standard browser APIs, which are present because we @require it directly.
            // Under Tampermonkey, window.JSZip or JSZip might be available.
            const ZipLib = window.JSZip || typeof JSZip !== 'undefined' ? JSZip : null;
            if (!ZipLib) {
                alert("JSZip failed to load from CDN. Try disabling tracking blockers for the CDN.");
                isExporting = false; dlBtn.style.opacity = '1'; dlBtn.style.pointerEvents = 'auto';
                return;
            }

            const zip = new ZipLib();
            let successCount = 0;
            let failedCount = 0;

            for (let i = 0; i < selectedCbs.length; i++) {
                const slug = selectedCbs[i].value;
                const meta = allChatsMap.get(slug);
                const titleStr = meta.title || "Untitled";
                statusLabel.innerText = `Fetching ${i + 1}/${selectedCbs.length}: ${titleStr.substring(0, 15)}...`;

                try {
                    const markdown = await extractThreadMarkdown(slug, titleStr);
                    if (markdown) {
                        const dateObj = meta.last_query_datetime ? new Date(meta.last_query_datetime) : new Date();
                        const dateStr = dateObj.toISOString().split('T')[0];
                        let safeTitle = titleStr.replace(/[/\\\\?%*:|"<>]/g, '-').trim();
                        if (!safeTitle) safeTitle = slug;
                        const filename = `${dateStr} - ${safeTitle}.md`;
                        zip.file(filename, markdown);
                        successCount++;
                    } else {
                        failedCount++;
                    }
                } catch (e) {
                    console.error('Failed to extract', slug, e);
                    failedCount++;
                }
            }

            statusLabel.innerText = 'Compressing to ZIP...';
            try {
                const blob = await zip.generateAsync({ type: 'blob' });
                // @require FileSaver.js provides saveAs
                if (typeof saveAs !== 'undefined') {
                    saveAs(blob, 'Perplexity_Chats_Backup.zip');
                } else if (window.saveAs) {
                    window.saveAs(blob, 'Perplexity_Chats_Backup.zip');
                } else {
                    // Fallback
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = 'Perplexity_Chats_Backup.zip';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }
                statusLabel.innerText = `Done! Downloaded ${successCount}${failedCount > 0 ? ' (Failed: ' + failedCount + ')' : ''}`;
            } catch (e) {
                alert('Error generating zip: ' + e.message);
                statusLabel.innerText = 'Error saving ZIP.';
            }

            isExporting = false;
            dlBtn.innerText = 'Download Selected as ZIP';
            dlBtn.style.opacity = '1';
            dlBtn.style.pointerEvents = 'auto';
        };

        modal.appendChild(header);
        modal.appendChild(body);
        body.appendChild(fetchBtn);
        body.appendChild(listContainer);
        modal.appendChild(footer);
        footer.appendChild(statusLabel);
        footer.appendChild(dlBtn);

        document.body.appendChild(modal);
    }

    async function extractThreadMarkdown(slug, title) {
        // We will create an iframe, load the slug, and allow the Tampermonkey iframe-script to intercept the fetch
        return new Promise(async (resolve, reject) => {

            // Experimental quick fetch attempt without iframe overhead:
            try {
                const directRes = await fetch('/rest/thread/' + slug, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (directRes.ok) {
                    const data = await directRes.json();
                    if (data && (data.length || data.entries || data.blocks)) {
                        return resolve(parseDataToMarkdown(data, title));
                    }
                }
            } catch (e) { console.debug("Direct fetch failed, falling back to iframe", e); }

            // Iframe fallback
            const url = 'https://www.perplexity.ai/search/' + slug;
            const iframe = document.createElement('iframe');
            iframe.name = 'pplx-batch-iframe';
            iframe.src = url;
            iframe.style.cssText = 'position:fixed; top:-9999px; left:-9999px; width:1000px; height:1000px; opacity:0; pointer-events:none;';

            let timeoutHandler;

            const messageHandler = (e) => {
                if (e.data && e.data.slug === slug) {
                    if (e.data.type === 'PPLX_BATCH_DATA') {
                        cleanup();
                        resolve(parseDataToMarkdown(e.data.data, title));
                    } else if (e.data.type === 'PPLX_BATCH_TIMEOUT') {
                        cleanup();
                        resolve(null); // Or fallback DOM extraction
                    }
                }
            };

            const cleanup = () => {
                window.removeEventListener('message', messageHandler);
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
                clearTimeout(timeoutHandler);
            };

            window.addEventListener('message', messageHandler);
            document.body.appendChild(iframe);

            timeoutHandler = setTimeout(() => {
                cleanup();
                console.warn('Timeout extracting thread ' + slug);
                resolve(null);
            }, 12000); // 12 seconds
        });
    }

    function parseDataToMarkdown(data, title) {
        let entries = [];
        if (Array.isArray(data)) {
            entries = data;
        } else if (data && Array.isArray(data.entries) && data.entries.length > 0) {
            entries = data.entries;
        } else if (data && (data.query_str || data.blocks || data.answer || data.text || data.content || data.message)) {
            entries = [data];
        }

        if (!entries.length) return null;

        function extractCleanMarkdown(val) {
            if (typeof val !== 'string') return '';
            let s = val.trim();
            if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
                try {
                    const parsed = JSON.parse(s);
                    if (Array.isArray(parsed)) {
                        const finalStep = parsed.find(step => step.step_type === 'FINAL' || step.step_type === 'COMPLETED');
                        if (finalStep && finalStep.content) {
                            const res = extractCleanMarkdown(finalStep.content.answer) || extractCleanMarkdown(finalStep.content.text) || extractCleanMarkdown(finalStep.content);
                            if (res) return res;
                        }
                        for (const step of parsed) {
                            const found = extractCleanMarkdown(step.content ? (step.content.answer || step.content.text || step.content) : null);
                            if (found && found.trim().length > 0) return found;
                        }
                    } else if (typeof parsed === 'object' && parsed !== null) {
                        if (parsed.structured_answer && Array.isArray(parsed.structured_answer)) {
                            return parsed.structured_answer.map(a => a.text || '').filter(Boolean).join('\n\n');
                        }
                        if (parsed.answer) return extractCleanMarkdown(parsed.answer);
                        if (parsed.text) return extractCleanMarkdown(parsed.text);
                        if (parsed.content) return extractCleanMarkdown(parsed.content);
                    }
                } catch (e) { }
            }
            return s; // If it's a normal string, or JSON parsing failed (meaning it's just standard markdown text), return it!
        }

        let markdown = '# ' + title + '\n\n';

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            let question = entry.query_str || entry.question || entry.prompt || '';

            if (!question) {
                question = (i === 0) ? title : 'Follow-up';
            }

            let fullAnswer = '';

            // 1. Try legacy blocks approach
            const blocks = entry.blocks || [];
            for (const block of blocks) {
                if (block.markdown_block && block.markdown_block.answer) {
                    fullAnswer += block.markdown_block.answer + '\n\n';
                } else if (block.text) {
                    fullAnswer += block.text + '\n\n';
                }
            }

            // 2. Try common object keys for answer (now safely decoded via extractCleanMarkdown)
            if (!fullAnswer.trim()) {
                const candidates = [entry.answer, entry.text, entry.content, entry.message?.content, entry.message];
                for (const candidate of candidates) {
                    const cleaned = extractCleanMarkdown(candidate);
                    if (cleaned && cleaned.trim().length > 0 && cleaned !== question) {
                        fullAnswer += cleaned + '\n\n';
                        break;
                    }
                }
            }

            // 3. Fallback: Deep search for strings that are very long (likely the answer)
            if (!fullAnswer.trim()) {
                let potentialAnswers = [];
                function extractLongStrings(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    if (Array.isArray(obj)) {
                        obj.forEach(extractLongStrings);
                        return;
                    }
                    for (const key in obj) {
                        const val = obj[key];
                        if (typeof val === 'string' && val.length > 20 && val !== question) {
                            if (!['query_str', 'slug', 'title', 'uuid', 'id', 'url', 'created_at'].includes(key)) {
                                const clean = extractCleanMarkdown(val);
                                if (clean && clean.trim().length > 10) {
                                    potentialAnswers.push({ key, val: clean });
                                }
                            }
                        } else if (typeof val === 'object') {
                            extractLongStrings(val);
                        }
                    }
                }
                extractLongStrings(entry);

                potentialAnswers.sort((a, b) => b.val.length - a.val.length);
                if (potentialAnswers.length > 0) {
                    const answerKeys = potentialAnswers.filter(pa => ['answer', 'text', 'content', 'markdown', 'message', 'body', 'code'].some(k => pa.key.toLowerCase().includes(k)));
                    if (answerKeys.length > 0) {
                        fullAnswer = answerKeys[0].val + '\n\n';
                    } else {
                        fullAnswer = potentialAnswers[0].val + '\n\n';
                    }
                }
            }

            // 4. Ultimate debug fallback
            if (!fullAnswer.trim()) {
                fullAnswer = "<!-- \nCOULD NOT FIND ANSWER. RAW JSON DATA FOR THIS ENTRY:\n" + JSON.stringify(entry, null, 2).replace(/-->/g, '-- >') + "\n-->\n\n";
            }

            if (question) markdown += '## ' + question + '\n\n';
            if (fullAnswer) markdown += fullAnswer.trim() + '\n\n';
            markdown += '---\n\n';
        }
        return markdown.trim();
    }

})();
