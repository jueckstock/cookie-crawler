'use strict';


const am = require('am');
const PublicSuffixList = require('publicsuffixlist');

const { Session } = require('./lib/launch');
const utils = require('./lib/utils');

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
            ({ url: navUrl, page } = utils.popRandomElement(availableLinks));
        }
        await utils.closeOtherPages(browser, page);
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

    const session = new Session();
    session.useBinary(CHROME_EXE).useTempProfile();

    if (USE_XVFB) {
        session.useXvfb();
    }

    let exitStatus = 0;
    await session.run(async (browser) => {
        await Promise.race([
            doPathfinderCrawl(browser, seedUrl, SPIDER_LINKS, (url) => {
                console.log(url);
            }),
            timeoutIn(MAX_CRAWL_TIME),
        ])
    }).catch(err => {
        console.error("error while browsing:", err);
        exitStatus = 1;
    });

    process.exit(exitStatus);
})