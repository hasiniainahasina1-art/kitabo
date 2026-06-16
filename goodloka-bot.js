// goodloka-bot.js – Bot de domino GoodLoka (STRATÉGIE EXPERT COMPLÈTE)
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;
const desiredScore = process.env.SCORE || '50';
const desiredMise  = process.env.MISE || '200';
const desiredJoueurs = process.env.JOUEURS || '2';
const waitTimeout = 5 * 60 * 1000;

process.env.DISPLAY = ':99';

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const DASHBOARD_FILE = path.join(__dirname, 'dashboard', 'game_state.json');
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
if (!fs.existsSync(DASHBOARD_DIR)) fs.mkdirSync(DASHBOARD_DIR, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Utilitaires DOM ---
async function fillFieldHuman(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage de ${fieldName}...`);
    let attempts = 0;
    while (attempts < 3) {
        try {
            await page.waitForSelector(selector, { visible: true, timeout: 10000 });
            break;
        } catch (e) {
            attempts++;
            if (attempts >= 3) throw new Error(`Champ ${fieldName} introuvable`);
        }
    }
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100 + Math.random() * 200);
    for (const char of value) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
    }
    await delay(200 + Math.random() * 300);
}

async function humanClickAt(page, coords) {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        await page.mouse.move(
            Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x,
            Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y
        );
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
}

async function findButtonByText(page, text) {
    const elements = await page.$$('button, a, [role="button"], input[type="submit"]');
    for (const el of elements) {
        try {
            const txt = await page.evaluate(el => el.textContent.trim() || el.value || '', el);
            if (txt === text) return el;
        } catch (e) {}
    }
    return null;
}

async function killChromePopups(page) {
    await page.evaluate(() => {
        document.querySelectorAll('div[role="dialog"], div[aria-label], .popup, .overlay, .modal').forEach(p => {
            if (p.offsetParent && !p.classList.contains('domino_board')) p.remove();
        });
    });
}

// --- Lecture du jeu ---
async function getBoardEnds(page) {
    return await page.evaluate(() => {
        const els = document.querySelectorAll('.domino_board .domino');
        if (els.length === 0) return null;
        const getVal = (el, side) => {
            const half = el.querySelector(`.domino_${side}`);
            return half ? (half.dataset?.value || half.getAttribute('data-value') || half.textContent.trim()) : null;
        };
        return { left: getVal(els[0], 'left'), right: getVal(els[els.length - 1], 'right') };
    });
}

async function getPlayableDominoes(page) {
    const handles = await page.$$('.mx_2.domino.cursor_pointer');
    return Promise.all(handles.map(async handle => {
        const info = await handle.evaluate(el => {
            const left = el.querySelector('.domino_left'), right = el.querySelector('.domino_right');
            return {
                value: `${left?.dataset?.value || left?.getAttribute('data-value') || left?.textContent.trim()}:${right?.dataset?.value || right?.getAttribute('data-value') || right?.textContent.trim()}`,
                leftVal: left?.dataset?.value || left?.getAttribute('data-value') || left?.textContent.trim(),
                rightVal: right?.dataset?.value || right?.getAttribute('data-value') || right?.textContent.trim()
            };
        });
        return { handle, ...info };
    }));
}

async function getFullHand(page) {
    return await page.evaluate(() => {
        const board = [...document.querySelectorAll('.domino_board .domino')];
        return [...document.querySelectorAll('.domino')]
            .filter(d => !board.includes(d))
            .map(d => {
                const left = d.querySelector('.domino_left'), right = d.querySelector('.domino_right');
                return {
                    value: `${left?.dataset?.value || left?.getAttribute('data-value') || left?.textContent.trim()}:${right?.dataset?.value || right?.getAttribute('data-value') || right?.textContent.trim()}`,
                    leftVal: left?.dataset?.value || left?.getAttribute('data-value') || left?.textContent.trim(),
                    rightVal: right?.dataset?.value || right?.getAttribute('data-value') || right?.textContent.trim(),
                    playable: d.classList.contains('cursor_pointer')
                };
            });
    });
}

// --- Suivi des dominos ---
let playedDominoes = new Set();
let opponentPassedValues = new Set();

function normalize(v1, v2) {
    const a = parseInt(v1), b = parseInt(v2);
    return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

async function updatePlayedDominoes(page) {
    const dominoes = await page.evaluate(() => {
        return [...document.querySelectorAll('.domino_board .domino')].map(el => {
            const left = el.querySelector('.domino_left'), right = el.querySelector('.domino_right');
            return {
                left: left?.dataset?.value || left?.getAttribute('data-value') || left?.textContent.trim(),
                right: right?.dataset?.value || right?.getAttribute('data-value') || right?.textContent.trim()
            };
        });
    });
    dominoes.forEach(d => { if (d.left !== '?' && d.right !== '?') playedDominoes.add(normalize(d.left, d.right)); });
}

// ============================================================
// STRATÉGIE EXPERT COMPLÈTE
// ============================================================

function allDominoes() {
    const all = [];
    for (let i = 0; i <= 6; i++)
        for (let j = i; j <= 6; j++)
            all.push({ left: i, right: j, value: `${i}:${j}` });
    return all;
}

function getUnknownSet(myHandValues) {
    const all = allDominoes();
    return new Set(all.filter(d => !playedDominoes.has(d.value) && !myHandValues.has(d.value)).map(d => d.value));
}

function getOpponentPossibleHand(unknownSet) {
    const possible = new Set();
    for (const dom of unknownSet) {
        const [a, b] = dom.split(':').map(Number);
        if (!opponentPassedValues.has(a) && !opponentPassedValues.has(b)) possible.add(dom);
    }
    return possible;
}

function countRemainingInUnknown(value, unknownSet) {
    let count = 0;
    for (const dom of unknownSet) {
        const [a, b] = dom.split(':').map(Number);
        if (a === value || b === value) count++;
    }
    return count;
}

function getFamilyControl(myHandValues, unknownSet) {
    const valueCount = {};
    for (let v = 0; v <= 6; v++) {
        let myCount = 0, totalLeft = 0;
        for (const dom of myHandValues) {
            const [a, b] = dom.split(':').map(Number);
            if (a === v || b === v) myCount++;
        }
        for (const dom of unknownSet) {
            const [a, b] = dom.split(':').map(Number);
            if (a === v || b === v) totalLeft++;
        }
        valueCount[v] = { myCount, totalLeft, control: myCount / (totalLeft + myCount + 0.01) };
    }
    return valueCount;
}

function simulateMove(boardEnds, domino, side) {
    const ends = { ...boardEnds };
    const val = side === 'left' ? ends.left : ends.right;
    if (domino.leftVal == val) ends[side] = domino.rightVal;
    else ends[side] = domino.leftVal;
    return ends;
}

function canWinNow(myHandPlayable, myHandAll) {
    if (myHandPlayable.length === 1 && myHandAll.length === 1) return myHandPlayable[0];
    return null;
}

function scoreMoveExpert(domino, ends, myHand, opponentPossibleHand, unknownSet, depth = 1) {
    if (depth === 0) {
        let s = 0;
        const handSum = myHand.reduce((sum, d) => sum + parseInt(d.leftVal) + parseInt(d.rightVal), 0);
        s -= (handSum - (parseInt(domino.leftVal) + parseInt(domino.rightVal))) * 0.8;
        if (domino.leftVal === domino.rightVal) s += 10;
        return s;
    }

    let bestScore = -Infinity;
    const placements = [];
    if (domino.leftVal == ends.left || domino.rightVal == ends.left) placements.push('left');
    if (domino.leftVal == ends.right || domino.rightVal == ends.right) placements.push('right');

    for (const side of placements) {
        const newEnds = simulateMove(ends, domino, side);
        const newHand = myHand.filter(d => d.value !== domino.value);
        let bonus = 0;

        if (newEnds.left === newEnds.right) {
            const remaining = [...opponentPossibleHand].filter(d => {
                const [a, b] = d.split(':').map(Number);
                return a === parseInt(newEnds.left) || b === parseInt(newEnds.left);
            }).length;
            if (remaining === 0) bonus += 200;
            else if (remaining <= 1) bonus += 80;
            else bonus += 30;
        }

        const family = getFamilyControl(new Set(newHand.map(d => d.value)), unknownSet);
        const likelyAdv = Object.entries(family).filter(([_, v]) => v.control < 0.3).map(([val]) => val);
        if (likelyAdv.includes(newEnds.left.toString())) bonus -= 20;
        if (likelyAdv.includes(newEnds.right.toString())) bonus -= 20;

        const newSum = newHand.reduce((s, d) => s + parseInt(d.leftVal) + parseInt(d.rightVal), 0);
        bonus -= newSum * 0.6;
        if (domino.leftVal === domino.rightVal) bonus += 15;

        if (depth > 0 && opponentPossibleHand.size > 0) {
            const oppHand = [...opponentPossibleHand].slice(0, 20).map(d => {
                const [a, b] = d.split(':').map(Number);
                return { value: d, leftVal: a.toString(), rightVal: b.toString() };
            });
            let worstForMe = Infinity;
            for (const oppDom of oppHand) {
                if (oppDom.leftVal == newEnds.left || oppDom.rightVal == newEnds.left ||
                    oppDom.leftVal == newEnds.right || oppDom.rightVal == newEnds.right) {
                    const sc = scoreMoveExpert(oppDom, newEnds, newHand, new Set(), unknownSet, 0);
                    if (sc < worstForMe) worstForMe = sc;
                }
            }
            if (worstForMe !== Infinity) bonus += worstForMe * 0.3;
        }
        if (bonus > bestScore) bestScore = bonus;
    }
    return bestScore;
}

function chooseBestDomino(hand, ends, unknownSet, myHandAll) {
    if (!ends) {
        const doubles = hand.filter(d => d.leftVal === d.rightVal);
        if (doubles.length > 0) {
            doubles.sort((a, b) => parseInt(b.leftVal) - parseInt(a.leftVal));
            return doubles[0];
        }
        hand.sort((a, b) => (parseInt(b.leftVal) + parseInt(b.rightVal)) - (parseInt(a.leftVal) + parseInt(a.rightVal)));
        return hand[0];
    }

    const opponentPossibleHand = getOpponentPossibleHand(unknownSet);
    const winNow = canWinNow(hand, myHandAll);
    if (winNow) { console.log('🏆 COUP GAGNANT !'); return winNow; }

    let best = null, bestScore = -Infinity;
    for (const domino of hand) {
        const s = scoreMoveExpert(domino, ends, hand, opponentPossibleHand, unknownSet, 2);
        if (s > bestScore) { bestScore = s; best = domino; }
    }
    return best || hand[0];
}

// --- Jouer un tour ---
async function playTurn(page, previousHandCount) {
    await updatePlayedDominoes(page);
    await killChromePopups(page);

    const ends = await getBoardEnds(page);
    console.log('🎯 Extrémités :', ends);
    let hand = await getPlayableDominoes(page);
    console.log(`🖐️ ${hand.length} dominos jouables`);

    if (hand.length === 0) return { status: 'skipped' };

    const myHandSet = new Set(hand.map(d => d.value));
    const unknownSet = getUnknownSet(myHandSet);
    const myHandAll = [...myHandSet].map(v => {
        const [a, b] = v.split(':').map(Number);
        return { value: v, leftVal: a.toString(), rightVal: b.toString() };
    });

    const chosen = chooseBestDomino(hand, ends, unknownSet, myHandAll);
    console.log(`🎯 Choix EXPERT : ${chosen.value}`);

    for (let attempt = 0; attempt < 3; attempt++) {
        const el = await page.evaluateHandle(({ lv, rv }) => {
            for (const d of document.querySelectorAll('.mx_2.domino.cursor_pointer')) {
                const left = d.querySelector('.domino_left'), right = d.querySelector('.domino_right');
                const a = left?.dataset?.value || left?.getAttribute('data-value') || left?.textContent.trim();
                const b = right?.dataset?.value || right?.getAttribute('data-value') || right?.textContent.trim();
                if (a === lv && b === rv) return d;
            }
            return null;
        }, { lv: chosen.leftVal, rv: chosen.rightVal });

        if (!el) { await delay(300); continue; }
        const box = await el.boundingBox();
        if (!box) { await delay(300); continue; }

        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(200);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        const jouerBtn = await findButtonByText(page, 'Jouer');
        if (jouerBtn) await jouerBtn.click();
        else await page.keyboard.press('Enter');

        await delay(1500);
        const newCount = await page.evaluate(() => {
            return document.querySelectorAll('.domino').length - document.querySelectorAll('.domino_board .domino').length;
        });

        if (newCount < previousHandCount) {
            console.log('✅ Coup joué');
            return { status: 'played' };
        }
        await delay(500);
    }
    return { status: 'failed' };
}

// --- Détection des passes adverses ---
async function detectOpponentPass(page, previousBoardEnds) {
    const currentEnds = await getBoardEnds(page);
    if (currentEnds && previousBoardEnds &&
        currentEnds.left === previousBoardEnds.left &&
        currentEnds.right === previousBoardEnds.right) {
        opponentPassedValues.add(parseInt(currentEnds.left));
        opponentPassedValues.add(parseInt(currentEnds.right));
        console.log(`🧠 Adversaire a passé sur ${currentEnds.left} et ${currentEnds.right}`);
    }
    return currentEnds;
}

// --- Détection fin ---
async function isRoundOver(page) {
    return await page.evaluate(() => {
        const t = document.body.innerText.toLowerCase();
        return /prochain round|manche terminée|a gagné/i.test(t) && !/votre tour|à vous/i.test(t);
    });
}

async function isMatchOver(page) {
    return await page.evaluate(() => {
        const t = document.body.innerText.toLowerCase();
        return /match terminé|victoire|défaite/i.test(t);
    });
}

async function waitForMyTurn(page, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        await killChromePopups(page);
        if (await isRoundOver(page)) return 'round_over';
        const myTurn = await page.evaluate(() => /votre tour|à vous de jouer/i.test(document.body.innerText));
        if (myTurn) { console.log('🔔 Mon tour !'); return 'my_turn'; }
        await delay(1000);
    }
    return 'timeout';
}

// --- Dashboard ---
async function saveDashboard(page) {
    try {
        const state = await page.evaluate(() => {
            const hand = [...document.querySelectorAll('.domino:not(.domino_board .domino)')].map(d => {
                const l = d.querySelector('.domino_left'), r = d.querySelector('.domino_right');
                return {
                    left: l?.dataset?.value || l?.getAttribute('data-value') || l?.textContent.trim() || '?',
                    right: r?.dataset?.value || r?.getAttribute('data-value') || r?.textContent.trim() || '?',
                    playable: d.classList.contains('cursor_pointer')
                };
            });
            const board = [...document.querySelectorAll('.domino_board .domino')].map(d => {
                const l = d.querySelector('.domino_left'), r = d.querySelector('.domino_right');
                return {
                    left: l?.dataset?.value || l?.getAttribute('data-value') || l?.textContent.trim() || '?',
                    right: r?.dataset?.value || r?.getAttribute('data-value') || r?.textContent.trim() || '?'
                };
            });
            const t = document.body.innerText.toLowerCase();
            return {
                hand, board,
                isMyTurn: /votre tour|à vous/i.test(t),
                isRoundOver: /prochain round|manche terminée/i.test(t),
                myHandCount: hand.length, boardCount: board.length,
                lastUpdate: new Date().toLocaleString('fr-FR')
            };
        });
        fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
}

// --- Manche ---
async function playOneRound(page, round) {
    console.log(`\n🎲 Manche ${round} (EXPERT)`);
    await delay(2000);
    playedDominoes.clear();
    opponentPassedValues.clear();
    let previousEnds = null;

    while (true) {
        await saveDashboard(page);

        if (previousEnds) await detectOpponentPass(page, previousEnds);

        const result = await waitForMyTurn(page);
        if (result === 'round_over') break;
        if (result === 'timeout') { await delay(2000); continue; }

        const hand = await getFullHand(page);
        console.log(`🃏 ${hand.length} dominos`);
        await playTurn(page, hand.length);

        previousEnds = await getBoardEnds(page);
        await delay(1000);
        if (await isRoundOver(page)) break;
    }
    await saveDashboard(page);
    console.log('⏳ Attente transition...');
    await delay(8000);
}

// --- MAIN ---
(async () => {
    console.log('🚀 Démarrage Kitabo EXPERT...');
    const { browser, page } = await connect({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        turnstile: false,
        connectOption: { defaultViewport: { width: 1920, height: 1080 } }
    });

    try {
        // 1. Connexion
        await page.goto('https://www.goodloka.com/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(3000);
        await fillFieldHuman(page, 'input[type="text"]', phone, 'Téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'Mot de passe');
        await page.keyboard.press('Enter');
        await delay(5000);
        console.log('✅ Connecté');

        // 2. Aller aux jeux
        await page.goto('https://www.goodloka.com/games/list', { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(3000);

        // 3. Jouer
        const jouerLink = await page.evaluateHandle(() => {
            return [...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Jouer' && a.offsetParent);
        });
        if (jouerLink) {
            const box = await jouerLink.boundingBox();
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await jouerLink.dispose();
            await delay(3000);
        }

        // 4. Créer partie
        (await findButtonByText(page, 'Créer une partie'))?.click();
        await delay(2000);

        for (const b of await page.$$('button')) {
            if ((await page.evaluate(el => el.textContent.trim(), b)).includes('Classique')) { await b.click(); break; }
        }
        await delay(500);
        (await findButtonByText(page, desiredScore))?.click();
        await delay(300);
        (await findButtonByText(page, desiredMise))?.click();
        await delay(300);
        (await findButtonByText(page, `${desiredJoueurs} joueurs`))?.click();
        await delay(300);
        (await findButtonByText(page, 'Créer la partie'))?.click();
        await delay(3000);
        console.log('✅ Partie créée');

        // 5. Attente première manche
        console.log('⏳ Attente première manche...');
        const start = Date.now();
        while (Date.now() - start < waitTimeout) {
            if (await page.$('.domino_board') || await findButtonByText(page, 'Jouer')) break;
            await delay(5000);
        }

        // 6. Boucle
        let round = 1;
        while (true) {
            if (await isMatchOver(page)) { console.log('🏆 Match terminé'); break; }
            await playOneRound(page, round);
            round++;
        }

    } catch (e) {
        console.error('❌', e.message);
    } finally {
        await browser.close();
        console.log('🛑 Fermé');
    }
})();
