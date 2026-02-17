import express, { Request, Response } from 'express';
import turnstile from './lib/ends/turnstile';
import iuam from './lib/ends/iuam';
import { connect } from "./lib/browser/br";

const app = express();
const port = process.env.PORT || 8742;
const authToken = process.env.authToken || null;

const MAX_CONCURRENT = Number(process.env.browserLimit) || 20;
const MAX_QUEUE = Number(process.env.maxQueue) || 50;
// 3 min default so captcha has time to resolve
(global as any).timeOut = Number(process.env.timeOut) || 180000;

const CACHE_TTL = 30 * 60 * 1000;

// ============================================================
// Concurrency control — semáforo ao invés de variável global mutável
// ============================================================
let activeCount = 0;
const waitQueue: Array<(value: void) => void> = [];

function acquireSlot(): Promise<void> {
    if (activeCount < MAX_CONCURRENT) {
        activeCount++;
        return Promise.resolve();
    }
    if (waitQueue.length >= MAX_QUEUE) {
        return Promise.reject(new Error("queue_full"));
    }
    return new Promise(resolve => waitQueue.push(resolve));
}

function releaseSlot() {
    if (waitQueue.length > 0) {
        const next = waitQueue.shift()!;
        next();
    } else {
        activeCount--;
    }
}

// ============================================================
// Cache com cleanup automático
// ============================================================
interface CacheEntry { expireAt: number; value: any; }
const memoryCache: Record<string, CacheEntry> = {};

function readCache(key: string): any {
    const entry = memoryCache[key];
    if (entry && Date.now() < entry.expireAt) return entry.value;
    if (entry) delete memoryCache[key];
    return null;
}

function writeCache(key: string, value: any, ttl: number = CACHE_TTL) {
    memoryCache[key] = { expireAt: Date.now() + ttl, value };
}

setInterval(() => {
    const now = Date.now();
    for (const key in memoryCache) {
        if (memoryCache[key].expireAt <= now) delete memoryCache[key];
    }
}, 5 * 60 * 1000);

// ============================================================
// Express setup
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = app.listen(port, () => {
    console.log(`Server running on port ${port} (max concurrent: ${MAX_CONCURRENT}, queue: ${MAX_QUEUE})`);
});
try { server.timeout = (global as any).timeOut + 30000; } catch { }

// ============================================================
// Browser — singleton reutilizado
// ============================================================
let browser: any = null;

async function initBrowser() {
    if (browser && browser.isConnected()) return browser;

    const { browser: b } = await connect({
        headless: false,
        turnstile: true,
        connectOption: { defaultViewport: { width: 640, height: 480 } },
        disableXvfb: false,
        args: [
            '--window-size=640,480',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--no-first-run',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-ipc-flooding-protection',
            '--disable-hang-monitor',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-domain-reliability',
            '--disable-client-side-phishing-detection',
            '--disable-component-extensions-with-background-pages',
            '--no-default-browser-check',
            '--autoplay-policy=no-user-gesture-required',
            '--js-flags=--max-old-space-size=128',
        ],
    });

    browser = b;
    browser.on('disconnected', () => { console.log('Browser disconnected'); browser = null; });
    return browser;
}

initBrowser().then(() => console.log("Browser initialized")).catch(err => console.error("Initial browser launch failed", err));

async function getPage() {
    if (!browser || !browser.isConnected()) await initBrowser();
    if (!browser) throw new Error("Browser not available");

    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    (page as any)._browserContext = context;

    await page.setRequestInterception(true);
    page.on('request', async (req: any) => {
        try {
            const type = req.resourceType();
            if (["image", "stylesheet", "font", "media"].includes(type)) {
                await req.abort();
            } else {
                await req.continue();
            }
        } catch (_) { }
    });

    return page;
}

async function closePage(page: any) {
    if (!page) return;
    try {
        const ctx = (page as any)._browserContext;
        if (ctx) await ctx.close();
        else await page.close();
    } catch { }
}

// ============================================================
// Routes
// ============================================================
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok',
        active: activeCount,
        queued: waitQueue.length,
        maxConcurrent: MAX_CONCURRENT,
        browserConnected: !!(browser && browser.isConnected()),
    });
});

app.post('/cloudflare', async (req: Request, res: Response): Promise<any> => {
    const startTime = Date.now();
    const data = req.body;

    if (!data || typeof data.mode !== 'string') {
        return res.status(400).json({ message: 'Bad Request: missing or invalid mode' });
    }
    if (authToken && data.authToken !== authToken) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    // Cache check antes de adquirir slot
    let cacheKey = "";
    if (data.mode === "iuam") {
        cacheKey = `${data.domain}|${data.userAgent || ''}`;
        const cached = readCache(cacheKey);
        if (cached) {
            return res.status(200).json({ ...cached, cached: true, elapsed: ((Date.now() - startTime) / 1000).toFixed(2) + 's' });
        }
    }

    // Adquire slot com fila
    try {
        await acquireSlot();
    } catch {
        return res.status(429).json({
            message: 'Too Many Requests',
            active: activeCount,
            queued: waitQueue.length,
        });
    }

    let result: any;
    let page: any = null;
    const reqT = Number(data.timeOut);
    const requestTimeout = reqT > 0 ? reqT : (global as any).timeOut;
    const prevTimeOut = (global as any).timeOut;
    (global as any).timeOut = requestTimeout;

    try {
        page = await getPage();

        switch (data.mode) {
            case "turnstile":
                result = await turnstile(data as any, page)
                    .then(token => ({ token }))
                    .catch(err => ({ code: 500, message: err.message }));
                break;

            case "iuam":
                result = await iuam(data as any, page)
                    .then(r => ({ ...r }))
                    .catch(err => ({ code: 500, message: err.message }));

                if (!result.code || result.code === 200) {
                    const ttl = Number(data.ttl || data.expire) || CACHE_TTL;
                    writeCache(cacheKey, result, ttl);
                }
                break;

            default:
                result = { code: 400, message: 'Invalid mode' };
        }
    } catch (err: any) {
        result = { code: 500, message: err.message };
    } finally {
        (global as any).timeOut = prevTimeOut;
        await closePage(page);
        releaseSlot();
    }

    if (!result.elapsed) {
        result.elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
    }
    res.status(result.code ?? 200).json(result);
});

app.use((_req: Request, res: Response) => {
    res.status(404).json({ message: 'Not Found' });
});

export default app;
