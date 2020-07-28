'use strict';

const am = require('am');

const { Session } = require('./lib/launch');
const utils = require('./lib/utils');

const CHROME_EXE = process.env.CHROME_EXE || '/usr/bin/google-chrome'
const PROFILE_DIR = process.env.PROFILE_DIR || false;
const USE_XVFB = !!process.env.USE_XVFB

const NAV_TIMEOUT = 30.0 * 1000
const NAV_COMPLETE_EVENT = 'networkidle2'


const MetricsCollector = (browser) => {
    const frameMetricsMap = new Map();
    browser.on('targetcreated', async (target) => {
        if (target.type() === "page") {
            const page = await target.page();
            page.on('request', request => {

            })
            page.on('')
        }
    });
    return () => {

    };
};


am(async (...urls) => {
    const session = new Session();
    session.useBinary(CHROME_EXE);

    if (PROFILE_DIR === false) {
        session.useTempProfile();
    }

    if (USE_XVFB) {
        session.useXvfb();
    }

    let exitStatus = 0;
    try {
        await session.run(async (browser) => {
            const page = await browser.newPage();

            for (const url of urls) {
                await utils.closeOtherPages(browser, page);
                await page.goto(url, {
                    timeout: NAV_TIMEOUT,
                    waitUntil: NAV_COMPLETE_EVENT,
                });
            }
        });
    } catch (err) {
        console.error("error while browsing:", err);
        exitStatus = 1;
    }
    process.exit(exitStatus);
})