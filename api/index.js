const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Mobile User-Agent ───
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Platform Detection ───
function detectPlatform(url) {
    if (/douyin|抖音|iesdouyin|v\.douyin/i.test(url)) return 'douyin';
    if (/kuaishou|快手|v\.kuaishou|v\.kwai|kwai/i.test(url)) return 'kuaishou';
    if (/xiaohongshu|小红书|xhslink|xhs/i.test(url)) return 'xiaohongshu';
    if (/bilibili|b站|b23\.tv|bilibili\.com/i.test(url)) return 'bilibili';
    return null;
}

// ─── Extract clean URL from share text ───
function extractUrl(text) {
    const urlMatch = text.match(/https?:\/\/[^\s\u4e00-\u9fff]+/);
    if (urlMatch) {
        return urlMatch[0].replace(/[，。！？、；：""''）】》]+$/, '');
    }
    return text.trim();
}

// ─── Follow redirects and return final URL ───
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

// ─── Parse Douyin ───
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

    if (!videoId) throw new Error('无法提取视频ID，请检查链接');

    const pageUrl = `https://www.iesdouyin.com/share/video/${videoId}`;
    const resp = await fetch(pageUrl, {
        headers: { 'User-Agent': MOBILE_UA }
    });
    const html = await resp.text();

    const dataMatch = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s);
    if (!dataMatch) throw new Error('页面数据解析失败，抖音可能已更新接口');

    let jsonData;
    try {
        jsonData = JSON.parse(dataMatch[1].trim());
    } catch (e) {
        throw new Error('JSON 数据解析失败');
    }

    try {
        const loaderData = jsonData.loaderData;
        const pageKey = Object.keys(loaderData).find(k => k.includes('/page'));
        if (!pageKey) throw new Error('找不到视频数据');

        const videoInfo = loaderData[pageKey].videoInfoRes;
        const item = videoInfo.item_list[0];

        const videoAddr = item.video?.play_addr;
        let videoUrl = videoAddr?.url_list?.[0] || '';
        if (videoUrl) {
            videoUrl = videoUrl.replace('playwm', 'play');
        }

        const musicInfo = item.music || {};

        return {
            title: item.desc || '未知标题',
            author: item.author?.nickname || '',
            cover: videoAddr?.cover?.url_list?.[0] || item.video?.cover?.url_list?.[0] || '',
            video_url: videoUrl,
            music_url: musicInfo.play_url?.url_list?.[0] || '',
            music_title: musicInfo.title ? `${musicInfo.title} - ${musicInfo.author || ''}` : '',
            platform: 'douyin'
        };
    } catch (e) {
        throw new Error('视频信息提取失败: ' + e.message);
    }
}

// ─── Parse Kuaishou ───
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

    if (!videoUrl) throw new Error('快手视频解析失败');
    return { title: title || '快手视频', author, cover, video_url: videoUrl, music_url: '', music_title: '', platform: 'kuaishou' };
}

// ─── Parse Xiaohongshu ───
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

    if (!videoUrl) throw new Error('小红书视频解析失败');
    return { title: title || '小红书视频', author, cover, video_url: videoUrl, music_url: '', music_title: '', platform: 'xiaohongshu' };
}

// ─── Parse Bilibili ───
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
    if (!bvid) throw new Error('无法提取B站视频ID');

    const apiResp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.bilibili.com/' }
    });
    const apiData = await apiResp.json();
    if (apiData.code !== 0) throw new Error(apiData.message || 'B站API请求失败');

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

    return { title: data.title || 'B站视频', author: data.owner?.name || '', cover: data.pic || '', video_url: videoUrl, music_url: '', music_title: '', platform: 'bilibili' };
}

// ─── API Routes ───

app.post('/api/parse', async (req, res) => {
    let { url, platform } = req.body;
    if (!url) return res.json({ code: -1, msg: '请提供视频链接' });
    url = extractUrl(url);
    const detectedPlatform = platform || detectPlatform(url);
    if (!detectedPlatform) return res.json({ code: -1, msg: '无法识别平台' });

    try {
        let result;
        switch (detectedPlatform) {
            case 'douyin': result = await parseDouyin(url); break;
            case 'kuaishou': result = await parseKuaishou(url); break;
            case 'xiaohongshu': result = await parseXiaohongshu(url); break;
            case 'bilibili': result = await parseBilibili(url); break;
            default: return res.json({ code: -1, msg: '不支持的平台' });
        }
        res.json({ code: 0, data: result });
    } catch (err) {
        res.json({ code: -1, msg: err.message });
    }
});

// ─── Download: 302 redirect to CDN (avoids timeout & CORS) ───
app.get('/api/download', async (req, res) => {
    const { url, filename, type } = req.query;
    if (!url) return res.status(400).json({ code: -1, msg: '缺少 url 参数' });

    try {
        const decodedUrl = decodeURIComponent(url);
        const safeName = (filename || 'video').replace(/[^\w\u4e00-\u9fff\-_.]/g, '').substring(0, 100);
        const isAudio = type === 'audio';
        const ext = isAudio ? 'mp3' : 'mp4';

        // Follow redirects to get final CDN URL
        let currentUrl = decodedUrl;
        for (let i = 0; i < 5; i++) {
            const resp = await fetch(currentUrl, {
                headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.douyin.com/' },
                redirect: 'manual'
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

        // Return JSON with the final CDN URL (frontend will handle download)
        res.json({
            code: 0,
            data: {
                url: currentUrl,
                filename: `${safeName}.${ext}`
            }
        });
    } catch (err) {
        res.status(500).json({ code: -1, msg: '获取下载链接失败: ' + err.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ─── Export for Vercel ───
module.exports = (req, res) => {
    return app(req, res);
};
