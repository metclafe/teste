const fs = require('fs');
const path = require('path');

interface CloudflareData {
    domain: string;
    userAgent?: string;
    proxy?: {
        username?: string;
        password?: string;
    };
}

const POLL_INTERVAL = 1500;
const MIN_CLEARANCE_LEN = 20;

async function cloudflare(data: CloudflareData, page: any): Promise<any> {
    if (!data.domain) throw new Error("Missing domain parameter");

    const startTime = Date.now();
    const timeout = (global as any).timeOut || 180000;

    // Seta o user-agent do cliente pra o cookie ser vinculado ao mesmo fingerprint
    if (data.userAgent) {
        await page.setUserAgent(data.userAgent);
    }

    if (data.proxy?.username && data.proxy?.password) {
        await page.authenticate({
            username: data.proxy.username,
            password: data.proxy.password,
        });
    }

    page.removeAllListeners("request");
    page.removeAllListeners("response");
    await page.setRequestInterception(true);

    // Armazena candidatos de clearance para validação posterior
    let candidateClearance: string | null = null;
    let candidateUserAgent: string | null = null;

    page.on("request", async (req: any) => {
        try {
            const reqUrl = req.url();
            if (reqUrl.includes("challenges.cloudflare.com/turnstile/v0/b/88d68f5d5ea3/api.js")) {
                const localPath = path.join(__dirname, '../js/api.js');
                try {
                    const body = fs.readFileSync(localPath);
                    await req.respond({
                        status: 200,
                        contentType: 'application/javascript',
                        body: body,
                        headers: { 'Access-Control-Allow-Origin': '*' }
                    });
                } catch (e) {
                    console.error("Failed to serve local api.js:", e);
                    await req.continue();
                }
            } else if (
                reqUrl === data.domain ||
                reqUrl.startsWith(data.domain) ||
                reqUrl.includes("challenges.cloudflare.com") ||
                reqUrl.includes("/cdn-cgi/challenge-platform/")
            ) {
                await req.continue();
            } else {
                await req.abort();
            }
        } catch (_) { }
    });

    // Captura candidatos via response headers
    page.on("response", async (res: any) => {
        try {
            const url = res.url();
            if (url.includes("/cdn-cgi/challenge-platform/")) {
                const headers = res.headers();
                if (headers["set-cookie"]) {
                    const match = headers["set-cookie"].match(/cf_clearance=([^;]+)/);
                    if (match && match[1].length >= MIN_CLEARANCE_LEN) {
                        candidateClearance = match[1];
                        candidateUserAgent = (await res.request().headers())["user-agent"];
                    }
                }
            }
        } catch (_) { }
    });

    await page.goto(data.domain, { waitUntil: "domcontentloaded" });

    // Loop de validação: aguarda confirmação real do cf_clearance nos cookies do browser
    const confirmed = await pollForClearance(page, data.domain, timeout, startTime);

    if (confirmed) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
        return {
            cf_clearance: confirmed.cf_clearance,
            user_agent: confirmed.user_agent || candidateUserAgent,
            elapsed,
        };
    }

    // Fallback: se o header capturou mas o cookie não confirmou, ainda tenta usar
    if (candidateClearance) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
        console.warn("cf_clearance found in headers but not confirmed in cookies, returning anyway");
        return {
            cf_clearance: candidateClearance,
            user_agent: candidateUserAgent,
            elapsed,
            warning: "unconfirmed",
        };
    }

    throw new Error("Timeout: captcha not resolved - cf_clearance not confirmed");
}

/**
 * Faz polling nos cookies do browser até encontrar cf_clearance válido
 * ou estourar o timeout. Isso garante que o captcha foi realmente resolvido.
 */
async function pollForClearance(
    page: any,
    domain: string,
    timeout: number,
    startTime: number
): Promise<{ cf_clearance: string; user_agent: string } | null> {
    const deadline = startTime + timeout;

    while (Date.now() < deadline) {
        try {
            // Verifica cookies reais do browser
            const cookies = await page.cookies(domain);
            const clearanceCookie = cookies.find(
                (c: any) => c.name === "cf_clearance" && c.value && c.value.length >= MIN_CLEARANCE_LEN
            );

            if (clearanceCookie) {
                const userAgent = await page.evaluate(() => navigator.userAgent);
                return {
                    cf_clearance: clearanceCookie.value,
                    user_agent: userAgent,
                };
            }

            // Verifica se a página saiu do challenge (não tem mais iframe do CF)
            const hasChallenge = await page.evaluate(() => {
                return !!document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                    !!document.querySelector('#challenge-running') ||
                    !!document.querySelector('#challenge-stage');
            }).catch(() => true);

            // Se não tem mais challenge e tem cookie, já resolveu
            if (!hasChallenge) {
                const cookiesRetry = await page.cookies(domain);
                const found = cookiesRetry.find(
                    (c: any) => c.name === "cf_clearance" && c.value && c.value.length >= MIN_CLEARANCE_LEN
                );
                if (found) {
                    const userAgent = await page.evaluate(() => navigator.userAgent);
                    return { cf_clearance: found.value, user_agent: userAgent };
                }
            }
        } catch (_) { }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    return null;
}

export = cloudflare;
