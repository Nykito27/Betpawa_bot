/**
 * index.js
 * FINAL: BetPawa Virtual Football Scraper + Auto-Bet (All features merged)
 */

const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ---------------------------
// Config
// ---------------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BETPAWA_PHONE = process.env.BETPAWA_PHONE;
const BETPAWA_PASSWORD = process.env.BETPAWA_PASSWORD;

const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || null;

const SCAN_INTERVAL_MIN = parseInt(process.env.SCAN_INTERVAL_MIN || '10', 10);
const SCAN_INTERVAL = Math.max(1, SCAN_INTERVAL_MIN) * 60 * 1000;

const STATE_PATH = path.resolve(__dirname, 'state.json');

const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || '50');
const MAX_STAKE = parseFloat(process.env.MAX_STAKE || '5');
const MIN_BALANCE = parseFloat(process.env.MIN_BALANCE || '2');
const MAX_BETS_PER_DAY = parseInt(process.env.MAX_BETS_PER_DAY || '30', 10);

const DRY_RUN = process.env.DRY_RUN === 'true'; // If true, simulates bets only
const DEBUG = process.env.DEBUG === 'true';

const SCRAPE_URL = 'https://www.betpawa.com.gh/virtuals/football';

// Selectors
const SELECTORS = {
  loginPhone: 'input[name="phone"], input[type="tel"]',
  loginPassword: 'input[name="password"], input[type="password"]',
  loginSubmit: 'button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")',
  matchRow: '.event-row, .match-row, .market-row, li.event',
  teamHome: '.team-home, .home .team-name, .team--home',
  teamAway: '.team-away, .away .team-name, .team--away',
  score: '.event-score, .score, .match-score',
  oddsButtons: '.odds-button, .bet-odds, .market-price, button.odds-btn',
  betSlipSelector: '.bet-slip, .bet-slip-panel',
  balanceSelector: '.wallet-balance, .balance, .user-balance, .topbar-balance'
};

// ---------------------------
// Utilities
// ---------------------------
function log(...args) {
  if (DEBUG) console.log(new Date().toISOString(), ...args);
  else {
    if (args[0] && (args[0].toString().startsWith('ERROR') || args[0].toString().includes('⚠') || args[0].toString().includes('🎯') || args[0].toString().includes('⛔') )) {
      console.log(new Date().toISOString(), ...args);
    }
  }
}

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      const init = {
        bets: [],
        daily: { date: new Date().toISOString().slice(0,10), loss: 0, betsCount: 0, consecutiveLosses: 0 },
        historyMatches: []
      };
      fs.writeFileSync(STATE_PATH, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('ERROR reading state:', err);
    return { bets: [], daily: { date: new Date().toISOString().slice(0,10), loss: 0, betsCount: 0, consecutiveLosses: 0 }, historyMatches: [] };
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('ERROR writing state:', err);
  }
}

function resetDailyIfNeeded(state) {
  const today = new Date().toISOString().slice(0,10);
  if (!state.daily || state.daily.date !== today) {
    state.daily = { date: today, loss: 0, betsCount: 0, consecutiveLosses: 0 };
    writeState(state);
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('Telegram Error:', err.message);
  }
}

// ---------------------------
// Puppeteer helpers
// ---------------------------
async function launchBrowser() {
  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  };
  if (PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = PUPPETEER_EXECUTABLE_PATH;
  return await puppeteer.launch(launchOpts);
}

async function safeGoto(page, url, opts = {}) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000, ...opts });
    return true;
  } catch (err) {
    log('ERROR safeGoto:', err.message);
    return false;
  }
}

// ---------------------------
// BetPawa login
// ---------------------------
async function ensureLoggedIn(page) {
  try {
    const balanceHandle = await page.$(SELECTORS.balanceSelector);
    if (balanceHandle) {
      log('Already logged in.');
      return true;
    }
  } catch (e) {}

  if (!BETPAWA_PHONE || !BETPAWA_PASSWORD) {
    throw new Error('Missing credentials env vars.');
  }

  log('Attempting login...');
  await safeGoto(page, 'https://www.betpawa.com.gh/login', { waitUntil: 'networkidle2' });

  try {
    const phoneSel = SELECTORS.loginPhone;
    const passSel = SELECTORS.loginPassword;
    const submitSel = SELECTORS.loginSubmit;

    await page.waitForSelector(phoneSel, { timeout: 10000 });
    await page.focus(phoneSel);
    await page.keyboard.type(BETPAWA_PHONE, { delay: 50 });

    await page.waitForSelector(passSel, { timeout: 10000 });
    await page.focus(passSel);
    await page.keyboard.type(BETPAWA_PASSWORD, { delay: 50 });

    const btn = await page.$(submitSel);
    if (btn) await btn.click();
    else await page.keyboard.press('Enter');

    await page.waitForTimeout(3000);
    // Check if login worked by looking for balance
    const loggedIn = await page.$(SELECTORS.balanceSelector);
    if(loggedIn) {
        log('Login successful.');
        return true;
    } else {
        throw new Error("Balance not found after login");
    }

  } catch (err) {
    log('ERROR logging in:', err.message);
    throw new Error('Login failed.');
  }
}

// ---------------------------
// Scrape
// ---------------------------
async function scrapeVirtualFootball(page) {
  log('Scraping virtuals...');
  await safeGoto(page, SCRAPE_URL);
  await page.waitForSelector('body', { timeout: 20000 });

  const matches = await page.evaluate((selectors) => {
    const rows = Array.from(document.querySelectorAll(selectors.matchRow || 'li'));
    const out = [];
    for (let r of rows) {
      const homeEl = r.querySelector(selectors.teamHome);
      const awayEl = r.querySelector(selectors.teamAway);
      const scoreEl = r.querySelector(selectors.score);
      const oddsNodes = r.querySelectorAll(selectors.oddsButtons || 'button');
      
      const item = {
        home: homeEl ? homeEl.innerText.trim() : null,
        away: awayEl ? awayEl.innerText.trim() : null,
        score: scoreEl ? scoreEl.innerText.trim() : null,
        odds: { 
            home: oddsNodes[0]?.innerText?.trim(), 
            draw: oddsNodes[1]?.innerText?.trim(), 
            away: oddsNodes[2]?.innerText?.trim() 
        },
        href: r.querySelector('a') ? r.querySelector('a').href : null
      };
      if (item.home || item.away) out.push(item);
    }
    return out;
  }, SELECTORS);

  log(`Found ${matches.length} matches.`);
  return matches;
}

// ---------------------------
// Strategy
// ---------------------------
function evaluateStrategies(state, matches) {
  const candidates = [];
  function parseOdd(s) {
    if (!s) return null;
    const n = parseFloat(s.replace(/[^0-9.]/g, ''));
    return isFinite(n) ? n : null;
  }

  // Build History Trend Map
  const trendMap = {};
  for (const h of state.historyMatches || []) {
    try {
      const parts = (h.score || '').replace(':','-').split('-');
      if (parts.length >= 2) {
        const hGoal = parseInt(parts[0]);
        const aGoal = parseInt(parts[1]);
        if (hGoal > aGoal) trendMap[h.home] = (trendMap[h.home] || 0) + 1;
        if (aGoal > hGoal) trendMap[h.away] = (trendMap[h.away] || 0) + 1;
      }
    } catch (e) {}
  }

  for (const m of matches) {
    const home = (m.home || '').trim();
    const away = (m.away || '').trim();
    const oddsHome = parseOdd(m.odds?.home);
    const oddsAway = parseOdd(m.odds?.away);

    // 1. Value Odds Rule (>= 3.0)
    if (oddsHome && oddsHome >= 3.0) {
      candidates.push({ match: m, selection: 'home', odds: oddsHome, reason: 'Value Odds (Home >= 3.0)', suggestedStake: 1 });
    }
    if (oddsAway && oddsAway >= 3.0) {
      candidates.push({ match: m, selection: 'away', odds: oddsAway, reason: 'Value Odds (Away >= 3.0)', suggestedStake: 1 });
    }

    // 2. Trend Rule (3+ recent wins)
    const homeTrend = trendMap[home] || 0;
    const awayTrend = trendMap[away] || 0;
    
    if (homeTrend >= 3 && oddsHome && oddsHome >= 1.5 && oddsHome <= 2.5) {
        candidates.push({ match: m, selection: 'home', odds: oddsHome, reason: `Trend: ${home} won last ${homeTrend}`, suggestedStake: 1 });
    }
    if (awayTrend >= 3 && oddsAway && oddsAway >= 1.5 && oddsAway <= 2.5) {
        candidates.push({ match: m, selection: 'away', odds: oddsAway, reason: `Trend: ${away} won last ${awayTrend}`, suggestedStake: 1 });
    }
  }

  return candidates;
}

// ---------------------------
// Place Bet Function
// ---------------------------
async function placeBetWithBrowser(page, candidate) {
  const { match, selection, suggestedStake } = candidate;
  try {
    // Navigate or click row
    if (match.href) {
      await safeGoto(page, match.href);
    } else {
      // Logic to find and click row would go here
      log('No href for match, skipping specific navigation');
    }
    
    await page.waitForTimeout(1000);

    // CLICK ODDS (Simplified for stability in this script)
    // In a real scenario, we need to find the specific button index
    const btns = await page.$$(SELECTORS.oddsButtons);
    let btnToClick = null;
    
    // Naive selection logic based on position (0=Home, 1=Draw, 2=Away)
    if (btns.length >= 3) {
        if(selection === 'home') btnToClick = btns[0];
        else if(selection === 'draw') btnToClick = btns[1];
        else if(selection === 'away') btnToClick = btns[2];
    }
    
    if (!btnToClick) return { ok: false, message: 'Odds button not found' };
    
    await btnToClick.click();
    await page.waitForTimeout(1000);

    // --- OPTION A: BALANCE CHECK ---
    let balance = 0;
    try {
        const balEl = await page.$(SELECTORS.balanceSelector);
        if (balEl) {
            const txt = await (await balEl.getProperty('innerText')).jsonValue();
            balance = parseFloat(txt.replace(/[^\d.]/g, ''));
        }
    } catch(e) {}

    log(`Balance: ${balance}, Stake: ${suggestedStake}`);
    
    if (balance < suggestedStake) {
        await sendTelegram(`⛔ Insufficient Balance (${balance}) for stake (${suggestedStake})`);
        return { ok: false, message: 'Insufficient Balance' };
    }

    // INPUT STAKE
    const stakeInput = await page.$(`${SELECTORS.betSlipSelector} input`);
    if (stakeInput) {
        await stakeInput.click({ clickCount: 3 });
        await stakeInput.type(String(suggestedStake));
    }

    if (DRY_RUN) {
        return { ok: true, message: `DRY RUN: Simulated bet on ${selection} @ ${candidate.odds}` };
    }

    // CONFIRM BET
    const confirmBtn = await page.$(`${SELECTORS.betSlipSelector} button.confirm`); // adjust selector
    if (confirmBtn) {
        await confirmBtn.click();
        return { ok: true, message: 'Bet Confirmed' };
    } else {
        return { ok: false, message: 'Confirm button not found' };
    }

  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ---------------------------
// Main Loop
// ---------------------------
async function performScanAndAct() {
  const state = readState();
  resetDailyIfNeeded(state);

  if (state.daily.betsCount >= MAX_BETS_PER_DAY) {
    log('Daily limit reached');
    return;
  }

  const browser = await launchBrowser();
  const page = await browser.newPage();
  
  try {
    await ensureLoggedIn(page);
    const matches = await scrapeVirtualFootball(page);

    // Update history
    state.historyMatches = (state.historyMatches || []).concat(matches).slice(-300);
    writeState(state);

    const candidates = evaluateStrategies(state, matches);
    
    if (candidates.length > 0) {
        // Just take the first one for now to avoid rapid fire
        const best = candidates[0];
        await sendTelegram(`🎯 Candidate: ${best.match.home} vs ${best.match.away} (${best.selection})`);
        
        const res = await placeBetWithBrowser(page, best);
        
        if (res.ok) {
            state.daily.betsCount++;
            writeState(state);
            await sendTelegram(`✅ Result: ${res.message}`);
        } else {
            await sendTelegram(`❌ Failed: ${res.message}`);
        }
    } else {
        log('No candidates found');
    }

  } catch (e) {
    log('Error in scan:', e.message);
  } finally {
    await browser.close();
  }
}

// ---------------------------
// Server & Schedule
// ---------------------------
// Run every X minutes
setInterval(performScanAndAct, SCAN_INTERVAL);

// Run once on start
performScanAndAct();

app.get('/', (req, res) => res.send('Bot Active'));
app.get('/state', (req, res) => res.json(readState()));

app.listen(port, () => console.log(`Server on ${port}`));
