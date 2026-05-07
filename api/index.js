const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

// 鈹€鈹€鈹€ Mobile User-Agent 鈹€鈹€鈹€
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 鈹€鈹€鈹€ Platform Detection 鈹€鈹€鈹€
function detectPlatform(url) {
    if (/douyin|鎶栭煶|iesdouyin|v\.douyin/i.test(url)) return 'douyin';
    if (/kuaishou|蹇墜|v\.kuaishou|v\.kwai|kwai/i.test(url)) return 'kuaishou';
    if (/xiaohongshu|灏忕孩涔xhslink|xhs/i.test(url)) return 'xiaohongshu';
    if (/bilibili|b绔檤b23\.tv|bilibili\.com/i.test(url)) return 'bilibili';
    return null;
}

// 鈹€鈹€鈹€ Extract clean URL from share text 鈹€鈹€鈹€
function extractUrl(text) {
    const urlMatch = text.match(/https?:\/\/[^\s\u4e00-\u9fff]+/);
    if (urlMatch) {
        return urlMatch[0].replace(/[锛屻€傦紒锛熴€侊紱锛?"''锛夈€戙€媇+$/, '');
    }
    return text.trim();
}

// 鈹€鈹€鈹€ Follow redirects and return final URL 鈹€鈹€鈹€
async function resolveRedirects(url, maxRedirects = 5) {
    let currentUrl = url;
    for (let i = 0; i < maxRedirects; i++) {
        try {
            const resp = await fetch(currentUrl, {
                headers: { 'User-Agent': MOBILE_UA },
                redirect: 'manual'
            });
            if (resp.status >= 300 && resp.status < 400) {
                const location = resp.headers.get('location');
                if (location) {
                    currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
                } else {
                    break;
                }
            } else {
                break;
            }
        } catch (e) {
            break;
        }
    }
    return currentUrl;
}

// 鈹€鈹€鈹€ Parse Douyin 鈹€鈹€鈹€
async function parseDouyin(url) {
    let videoId = null;
    const idMatch = url.match(/video\/(\d+)/);
    if (idMatch) {
        videoId = idMatch[1];
    } else {
        const finalUrl = await resolveRedirects(url);
        const match = finalUrl.match(/video\/(\d+)/);
        if (match) videoId = match[1];
        const noteMatch = finalUrl.match(/note\/(\d+)/);
        if (noteMatch) videoId = noteMatch[1];
    }

    if (!videoId) throw new Error('鏃犳硶鎻愬彇瑙嗛ID锛岃妫€鏌ラ摼鎺?);

    const pageUrl = `https://www.iesdouyin.com/share/video/${videoId}`;
    const resp = await fetch(pageUrl, {
        headers: { 'User-Agent': MOBILE_UA }
    });
    const html = await resp.text();

    const dataMatch = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s);
    if (!dataMatch) throw new Error('椤甸潰鏁版嵁瑙ｆ瀽澶辫触锛屾姈闊冲彲鑳藉凡鏇存柊鎺ュ彛');

    let jsonData;
    try {
        jsonData = JSON.parse(dataMatch[1].trim());
    } catch (e) {
        throw new Error('JSON 鏁版嵁瑙ｆ瀽澶辫触');
    }

    try {
        const loaderData = jsonData.loaderData;
        const pageKey = Object.keys(loaderData).find(k => k.includes('/page'));
        if (!pageKey) throw new Error('鎵句笉鍒拌棰戞暟鎹?);

        const videoInfo = loaderData[pageKey].videoInfoRes;
        const item = videoInfo.item_list[0];

        const videoAddr = item.video?.play_addr;
        let videoUrl = videoAddr?.url_list?.[0] || '';
        if (videoUrl) {
            videoUrl = videoUrl.replace('playwm', 'play');
        }

        const musicInfo = item.music || {};

        return {
            title: item.desc || '鏈煡鏍囬',
            author: item.author?.nickname || '',
            cover: videoAddr?.cover?.url_list?.[0] || item.video?.cover?.url_list?.[0] || '',
            video_url: videoUrl,
            music_url: musicInfo.play_url?.url_list?.[0] || '',
            music_title: musicInfo.title ? `${musicInfo.title} - ${musicInfo.author || ''}` : '',
            platform: 'douyin'
        };
    } catch (e) {
        throw new Error('瑙嗛淇℃伅鎻愬彇澶辫触: ' + e.message);
    }
}

// 鈹€鈹€鈹€ Parse Kuaishou 鈹€鈹€鈹€
async function parseKuaishou(url) {
    let finalUrl = url;
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': MOBILE_UA },
            redirect: 'manual'
        });
        const location = resp.headers.get('location');
        if (location) finalUrl = location;
    } catch (e) {}

    const resp = await fetch(finalUrl, {
        headers: { 'User-Agent': MOBILE_UA }
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    let videoUrl = '', title = '', author = '', cover = '';
    $('script').each((i, el) => {
        const content = $(el).html() || '';
        if (content.includes('videoData') || content.includes('pageData')) {
            const urlMatch = content.match(/"src"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/);
            if (urlMatch) videoUrl = urlMatch[1];
            const titleMatch = content.match(/"caption"\s*:\s*"([^"]+)"/);
            if (titleMatch) title = titleMatch[1];
            const authorMatch = content.match(/"userName"\s*:\s*"([^"]+)"/);
            if (authorMatch) author = authorMatch[1];
            const coverMatch = content.match(/"poster"\s*:\s*"(https?:\/\/[^"]+)"/);
            if (coverMatch) cover = coverMatch[1];
        }
    });

    if (!videoUrl) {
        const ogVideo = $('meta[property="og:video"]').attr('content');
        if (ogVideo) videoUrl = ogVideo;
    }
    if (!title) {
        const ogTitle = $('meta[property="og:title"]').attr('content');
        if (ogTitle) title = ogTitle;
    }
    if (!cover) {
        const ogImage = $('meta[property="og:image"]').attr('content');
        if (ogImage) cover = ogImage;
    }

    if (!videoUrl) throw new Error('蹇墜瑙嗛瑙ｆ瀽澶辫触');
    return { title: title || '蹇墜瑙嗛', author, cover, video_url: videoUrl, music_url: '', music_title: '', platform: 'kuaishou' };
}

// 鈹€鈹€鈹€ Parse Xiaohongshu 鈹€鈹€鈹€
async function parseXiaohongshu(url) {
    let finalUrl = url;
    try {
        const resp = await fetch(url, { headers: { 'User-Agent': MOBILE_UA }, redirect: 'manual' });
        const location = resp.headers.get('location');
        if (location) finalUrl = location;
    } catch (e) {}

    const resp = await fetch(finalUrl, { headers: { 'User-Agent': MOBILE_UA } });
    const html = await resp.text();
    const $ = cheerio.load(html);

    let videoUrl = '', title = '', author = '', cover = '';
    $('script').each((i, el) => {
        const content = $(el).html() || '';
        if (content.includes('noteDetailMap')) {
            const urlMatch = content.match(/"url"\s*:\s*"(https?:\/\/sns-video[^"]+|https?:\/\/[^\s"]+video[^\s"]+)"/);
            if (urlMatch) videoUrl = urlMatch[1];
            const titleMatch = content.match(/"title"\s*:\s*"([^"]+)"/);
            if (titleMatch) title = titleMatch[1];
            const authorMatch = content.match(/"nickname"\s*:\s*"([^"]+)"/);
            if (authorMatch) author = authorMatch[1];
            const coverMatch = content.match(/"urlDefault"\s*:\s*"(https?:\/\/[^"]+)"/);
            if (coverMatch) cover = coverMatch[1];
        }
    });

    if (!videoUrl) { const ogVideo = $('meta[property="og:video"]').attr('content'); if (ogVideo) videoUrl = ogVideo; }
    if (!title) { const ogTitle = $('meta[property="og:title"]').attr('content'); if (ogTitle) title = ogTitle; }
    if (!cover) { const ogImage = $('meta[property="og:image"]').attr('content'); if (ogImage) cover = ogImage; }

    if (!videoUrl) throw new Error('灏忕孩涔﹁棰戣В鏋愬け璐?);
    return { title: title || '灏忕孩涔﹁棰?, author, cover, video_url: videoUrl, music_url: '', music_title: '', platform: 'xiaohongshu' };
}

// 鈹€鈹€鈹€ Parse Bilibili 鈹€鈹€鈹€
async function parseBilibili(url) {
    let bvid = '';
    const bvMatch = url.match(/(BV[a-zA-Z0-9]+)/);
    if (bvMatch) {
        bvid = bvMatch[1];
    } else {
        try {
            const resp = await fetch(url, { headers: { 'User-Agent': MOBILE_UA }, redirect: 'manual' });
            const location = resp.headers.get('location');
            if (location) { const bvMatch2 = location.match(/(BV[a-zA-Z0-9]+)/); if (bvMatch2) bvid = bvMatch2[1]; }
        } catch (e) {}
    }
    if (!bvid) throw new Error('鏃犳硶鎻愬彇B绔欒棰慖D');

    const apiResp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.bilibili.com/' }
    });
    const apiData = await apiResp.json();
    if (apiData.code !== 0) throw new Error(apiData.message || 'B绔橝PI璇锋眰澶辫触');

    const data = apiData.data;
    const cid = data.cid;
    const avid = data.aid;

    const streamResp = await fetch(
        `https://api.bilibili.com/x/player/playurl?avid=${avid}&cid=${cid}&qn=80&fnval=16&fourk=1`,
        { headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.bilibili.com/' } }
    );
    const streamData = await streamResp.json();

    let videoUrl = '';
    if (streamData.code === 0 && streamData.data) {
        if (streamData.data.dash && streamData.data.dash.video) {
            const videos = streamData.data.dash.video;
            const best = videos.sort((a, b) => b.bandwidth - a.bandwidth)[0];
            videoUrl = best?.baseUrl || best?.base_url || '';
        } else if (streamData.data.durl) {
            videoUrl = streamData.data.durl[0]?.url || '';
        }
    }

    return { title: data.title || 'B绔欒棰?, author: data.owner?.name || '', cover: data.pic || '', video_url: videoUrl, music_url: '', music_title: '', platform: 'bilibili' };
}

// 鈹€鈹€鈹€ API Routes 鈹€鈹€鈹€

app.post('/api/parse', async (req, res) => {
    let { url, platform } = req.body;
    if (!url) return res.json({ code: -1, msg: '璇锋彁渚涜棰戦摼鎺? });
    url = extractUrl(url);
    const detectedPlatform = platform || detectPlatform(url);
    if (!detectedPlatform) return res.json({ code: -1, msg: '鏃犳硶璇嗗埆骞冲彴' });

    try {
        let result;
        switch (detectedPlatform) {
            case 'douyin': result = await parseDouyin(url); break;
            case 'kuaishou': result = await parseKuaishou(url); break;
            case 'xiaohongshu': result = await parseXiaohongshu(url); break;
            case 'bilibili': result = await parseBilibili(url); break;
            default: return res.json({ code: -1, msg: '涓嶆敮鎸佺殑骞冲彴' });
        }
        res.json({ code: 0, data: result });
    } catch (err) {
        res.json({ code: -1, msg: err.message });
    }
});

app.get('/api/download', async (req, res) => {
    const { url, filename, type } = req.query;
    if (!url) return res.status(400).json({ code: -1, msg: '缂哄皯 url 鍙傛暟' });

    try {
        const decodedUrl = decodeURIComponent(url);
        const safeName = (filename || 'video').replace(/[^\w\u4e00-\u9fff\-_.]/g, '').substring(0, 100);
        const isAudio = type === 'audio';
        const ext = isAudio ? 'mp3' : 'mp4';

        let currentUrl = decodedUrl;
        let resp;
        for (let i = 0; i < 5; i++) {
            resp = await fetch(currentUrl, {
                headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.douyin.com/' }
            });
            if (resp.status >= 300 && resp.status < 400) {
                const location = resp.headers.get('location');
                if (location) {
                    currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
                    continue;
                }
            }
            break;
        }

        if (!resp || !resp.ok) {
            return res.status(502).json({ code: -1, msg: `涓嬭浇澶辫触: HTTP ${resp?.status}` });
        }

        const chunks = [];
        for await (const chunk of resp.body) { chunks.push(chunk); }
        const buffer = Buffer.concat(chunks);

        res.set({
            'Content-Type': isAudio ? 'audio/mpeg' : 'video/mp4',
            'Content-Length': buffer.length,
            'Content-Disposition': `attachment; filename="${safeName}.${ext}"; filename*=UTF-8''${safeName}.${ext}`,
        });
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ code: -1, msg: '涓嬭浇澶辫触: ' + err.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// 鈹€鈹€鈹€ Export for Vercel 鈹€鈹€鈹€
module.exports = app;
