'use strict';
const pptr = require('puppeteer-core');
const am = require('am');
const rimraf = require('rimraf');
const PublicSuffixList = require('publicsuffixlist');
const fs = require('fs/promises');
const Xvfb = require('xvfb');

const CHROME_EXE = process.env.CHROME_EXE || '/usr/bin/google-chrome'
const USE_XVFB = !!process.env.USE_XVFB
const SPIDER_LINKS = +process.env.SPIDER_LINKS || 10
const NAV_TIMEOUT = 30.0 * 1000
const NAV_COMPLETE_EVENT = 'domcontentloaded'
const MAX_CRAWL_TIME = 180.0 * 1000


const SamePublicSuffixPredicate = () => {
    const psl = new PublicSuffixList();
    psl.initializeSync();

    return (pageUrl, linkUrl) => {
        return (linkUrl.protocol.startsWith('http')
            && psl.domain(pageUrl.hostname) === psl.domain(linkUrl.hostname));
    };
}

const LinkHarvester = (browser, linkPredicate) => {
    return async () => {
        const links = [];
        for (const page of await browser.pages()) {
            try {
                const pageUrl = new URL(page.url());
                for (const aTag of await page.$$('a[href]')) {
                    const tagHref = await page.evaluate(a => a.href, aTag);
                    try {
                        const tagUrl = new URL(tagHref, pageUrl);
                        if (linkPredicate(pageUrl, tagUrl)) {
                            links.push({
                                url: tagUrl.toString(),
                                page: page,
                            });
                        }
                    } catch (err) {
                        console.error("link-harvesting href processing error:", err);
                    }
                }
            } catch (err) {
                console.error("link-harvesting page processing error:", err);
            }
        }
        return links;
    }
};

const closeOtherPages = async (browser, page) => {
    const allPages = await browser.pages()
    const pi = allPages.indexOf(page)
    if (pi < 0) {
        throw Error('no such page in browser')
    }
    allPages.splice(pi, 1)
    return Promise.all(allPages.map((p) => p.close()))
}

// The maximum is exclusive and the minimum is inclusive
function getRandomInt(min, max) {
    min = Math.ceil(min)
    max = Math.floor(max)
    return Math.floor(Math.random() * (max - min)) + min
}

function popRandomElement(array) {
    const ix = getRandomInt(0, array.length);
    const el = array[ix];
    array.splice(ix, 1);
    return el;
}

const doPathfinderCrawl = async (browser, seedUrl, spiderCount, recordNavUrl) => {
    const harvestLinks = LinkHarvester(browser, SamePublicSuffixPredicate());
    const page = await browser.newPage();

    await page.goto(seedUrl, {
        timeout: NAV_TIMEOUT,
        waitUntil: NAV_COMPLETE_EVENT,
    });

    let lastUrl = page.url();
    recordNavUrl(lastUrl);

    const seenUrls = new Set();
    seenUrls.add(seedUrl);
    seenUrls.add(lastUrl);

    while (spiderCount > 0) {
        const availableLinks = await harvestLinks();
        let navUrl = lastUrl, page;
        while (seenUrls.has(navUrl)) {
            if (availableLinks.length === 0) {
                throw Error("hey, we ran outta links...");
            }
            ({ url: navUrl, page } = popRandomElement(availableLinks));
        }
        await closeOtherPages(browser, page);
        await page.goto(navUrl, {
            timeout: NAV_TIMEOUT,
            waitUntil: NAV_COMPLETE_EVENT,
            referer: lastUrl,
        });
        recordNavUrl(navUrl);
        lastUrl = navUrl;
        seenUrls.add(lastUrl);
        --spiderCount;
    }
}

const timeoutIn = (ms) => new Promise((resolve, _) => { setTimeout(resolve, ms) });

am(async (seedUrl) => {
    const tempDir = await fs.mkdtemp("pfc_")
    process.on('exit', () => {
        console.error(`wiping out temp dir: ${tempDir}`)
        rimraf.sync(tempDir)
    })

    let closeXvfb
    if (USE_XVFB) {
        const xServer = new Xvfb();
        xServer.startSync()
        closeXvfb = () => {
            console.error('tearing down Xvfb')
            xServer.stopSync()
        }
    } else {
        closeXvfb = () => { }
    }

    const browser = await pptr.launch({
        executablePath: CHROME_EXE,
        defaultViewport: null,
        userDataDir: tempDir,
        headless: false,
    })

    try {
        await Promise.race([
            doPathfinderCrawl(browser, seedUrl, SPIDER_LINKS, (url) => {
                console.log(url);
            }),
            timeoutIn(MAX_CRAWL_TIME),
        ]);
    } catch (err) {
        console.error("crawl error:", err);
    } finally {
        await browser.close().catch(err => console.error("browser shutdown error:", err));
        try {
            closeXvfb()
        } catch { }
        process.exit();
    }
})