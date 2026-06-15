// kitabo.js – Bot de domino GoodLoka
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;
const desiredScore = process.env.SCORE || '50';
const desiredMise  = process.env.MISE || '200';
const desiredJoueurs = process.env.JOUEURS || '2';

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
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
        try {
            await page.waitForSelector(selector, { visible: true, timeout: 10000 });
            break;
        } catch (e) {
            attempts++;
            if (attempts >= maxAttempts) throw new Error(`Champ ${fieldName} introuvable`);
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

async function findButtonByText(page, text) {
    const btns = await page.$$('button');
    for (const btn of btns) {
        const txt = await page.evaluate(el => el.textContent.trim(), btn);
        if (txt === text) return btn;
    }
    // Chercher aussi dans les liens et autres éléments cliquables
    const elements = await page.$$('a, button, [role="button"], input[type="submit"]');
    for (const el of elements) {
        const txt = await page.evaluate(el => el.textContent.trim() || el.value || '', el);
        if (txt === text) return el;
    }
    return null;
}

async function killChromePopups(page) {
    await page.evaluate(() => {
        const popups = document.querySelectorAll('div[role="dialog"], div[aria-label], .popup, .overlay, .modal');
        popups.forEach(p => {
            if (p.offsetParent && !p.classList.contains('domino_board')) p.remove();
        });
        const infobars = document.querySelectorAll('div.infobar, div[class*="infobar"]');
        infobars.forEach(i => i.style.display = 'none');
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
        return {
            left: getVal(els[0], 'left'),
            right: getVal(els[els.length - 1], 'right')
        };
    });
}

async function getPlayableDominoes(page) {
    const handles = await page.$$('.mx_2.domino.cursor_pointer');
    const dominoes = [];
    for (const handle of handles) {
        const info = await handle.evaluate(el => {
            const left = el.querySelector('.domino_left');
            const right = el.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return { value: `${lv}:${rv}`, leftVal: lv, rightVal: rv, index: el.getAttribute('data-index') };
        });
        dominoes.push({ handle, ...info });
    }
    return dominoes;
}

async function getFullHand(page) {
    return await page.evaluate(() => {
        const boardDominoes = [...document.querySelectorAll('.domino_board .domino')];
        const allDominoes = [...document.querySelectorAll('.domino')];
        return allDominoes
            .filter(d => !boardDominoes.includes(d))
            .map(d => {
                const left = d.querySelector('.domino_left');
                const right = d.querySelector('.domino_right');
                const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
                const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
                return { value: `${lv}:${rv}`, leftVal: lv, rightVal: rv, playable: d.classList.contains('cursor_pointer') };
            });
    });
}

// --- Suivi des dominos joués ---
let playedDominoes = new Set();

function normalize(v1, v2) {
    const a = parseInt(v1);
    const b = parseInt(v2);
    return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

async function updatePlayedDominoes(page) {
    const dominoes = await page.evaluate(() => {
        const els = document.querySelectorAll('.domino_board .domino');
        return [...els].map(el => {
            const left = el.querySelector('.domino_left');
            const right = el.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return { left: lv, right: rv };
        });
    });
    dominoes.forEach(d => {
        if (d.left !== '?' && d.right !== '?') {
            playedDominoes.add(normalize(d.left, d.right));
        }
    });
}

// --- Stratégie ---
function getUnknownDominoes(playedSet, myHandSet) {
    const unknown = new Set();
    for (let i = 0; i <= 6; i++) {
        for (let j = i; j <= 6; j++) {
            const dom = normalize(i, j);
            if (!playedSet.has(dom) && !myHandSet.has(dom)) unknown.add(dom);
        }
    }
    return unknown;
}

function countRemainingInUnknown(value, unknownSet) {
    let count = 0;
    for (const dom of unknownSet) {
        const [a, b] = dom.split(':').map(Number);
        if (a === value || b === value) count++;
    }
    return count;
}

function getLikelyAdversaryValues(unknownSet) {
    const freq = {};
    for (const dom of unknownSet) {
        const [a, b] = dom.split(':').map(Number);
        freq[a] = (freq[a] || 0) + 1;
        freq[b] = (freq[b] || 0) + 1;
    }
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return new Set(sorted.slice(0, 2).map(e => e[0]));
}

function scoreMove(domino, ends, hand, playedSet, unknownSet) {
    let score = 0;
    const { left, right } = ends;
    const valLeft = parseInt(domino.leftVal);
    const valRight = parseInt(domino.rightVal);

    const matchesLeft = (valLeft === parseInt(left) || valRight === parseInt(left));
    const matchesRight = (valLeft === parseInt(right) || valRight === parseInt(right));
    if (!matchesLeft && !matchesRight) return -Infinity;

    const newLeft = matchesLeft ? (valLeft === parseInt(left) ? valRight : valLeft) : left;
    const newRight = matchesRight ? (valLeft === parseInt(right) ? valRight : valLeft) : right;

    if (newLeft === newRight) {
        const remaining = countRemainingInUnknown(parseInt(newLeft), unknownSet);
        if (remaining <= 1) score += 70;
        else if (remaining <= 3) score += 30;
        else score += 10;
    }

    const handSum = hand.reduce((sum, d) => sum + parseInt(d.leftVal) + parseInt(d.rightVal), 0);
    const dominoSum = valLeft + valRight;
    const remainingSum = handSum - dominoSum;
    score -= remainingSum * 0.7;

    if (domino.leftVal === domino.rightVal) score += 15;

    const likelyAdversary = getLikelyAdversaryValues(unknownSet);
    if (likelyAdversary.has(newLeft.toString())) score -= 25;
    if (likelyAdversary.has(newRight.toString())) score -= 25;
    if (!likelyAdversary.has(newLeft.toString())) score += 10;
    if (!likelyAdversary.has(newRight.toString())) score += 10;

    return score;
}

function chooseBestDomino(hand, ends, playedSet, unknownSet, excludeValues = new Set()) {
    const filteredHand = hand.filter(d => !excludeValues.has(d.value));
    const effectiveHand = filteredHand.length > 0 ? filteredHand : hand;

    if (!ends) {
        const doubles = effectiveHand.filter(d => d.leftVal === d.rightVal);
        if (doubles.length > 0) {
            doubles.sort((a, b) => parseInt(b.leftVal) - parseInt(a.leftVal));
            return doubles[0];
        }
        effectiveHand.sort((a, b) => (parseInt(b.leftVal) + parseInt(b.rightVal)) - (parseInt(a.leftVal) + parseInt(a.rightVal)));
        return effectiveHand[0];
    }

    let best = null;
    let bestScore = -Infinity;
    for (const domino of effectiveHand) {
        const s = scoreMove(domino, ends, effectiveHand, playedSet, unknownSet);
        if (s > bestScore) {
            bestScore = s;
            best = domino;
        }
    }
    return best || effectiveHand[0];
}

// --- Jouer un tour ---
async function playTurn(page, previousHandCount, failedValues) {
    await updatePlayedDominoes(page);
    await killChromePopups(page);

    const ends = await getBoardEnds(page);
    console.log('🎯 Extrémités :', ends);
    let hand = await getPlayableDominoes(page);
    console.log(`🖐️ ${hand.length} dominos jouables`);

    if (hand.length === 0) {
        console.log('🤷 Aucun domino jouable, on passe.');
        return { status: 'skipped' };
    }

    const myHandSet = new Set(hand.map(d => d.value));
    const unknownSet = getUnknownDominoes(playedDominoes, myHandSet);
    const chosen = chooseBestDomino(hand, ends, playedDominoes, unknownSet, failedValues);
    console.log(`🎯 Choix : ${chosen.value}`);

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        const dominoElement = await page.evaluateHandle(({ leftVal, rightVal }) => {
            const dominos = document.querySelectorAll('.mx_2.domino.cursor_pointer');
            for (const d of dominos) {
                const left = d.querySelector('.domino_left');
                const right = d.querySelector('.domino_right');
                const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : null;
                const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : null;
                if (lv === leftVal && rv === rightVal) return d;
            }
            return null;
        }, { leftVal: chosen.leftVal, rightVal: chosen.rightVal });

        if (!dominoElement) { await delay(300); continue; }

        const box = await dominoElement.boundingBox();
        if (!box) { await delay(300); continue; }

        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(200);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        success = true;
        break;
    }

    if (!success) {
        console.log('❌ Impossible de cliquer sur le domino.');
        return { status: 'failed', failedValue: chosen.value };
    }

    const jouerBtn = await findButtonByText(page, 'Jouer');
    if (jouerBtn) {
        await jouerBtn.click();
        console.log('🖱️ Jouer');
    } else {
        await page.keyboard.press('Enter');
        console.log('⏎ Entrée');
    }

    await delay(1500);
    const newHandCount = await page.evaluate(() => {
        const board = document.querySelectorAll('.domino_board .domino');
        const all = document.querySelectorAll('.domino');
        return all.length - board.length;
    });

    if (newHandCount >= previousHandCount) {
        console.log('⚠️ Le coup semble avoir échoué.');
        return { status: 'failed', failedValue: chosen.value };
    }

    console.log('✅ Coup joué avec succès.');
    return { status: 'played' };
}

// --- Détection de fin ---
async function isRoundOver(page) {
    return await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase();
        if (/prochain round dans|next round in/i.test(bodyText)) return true;
        if (/a gagné|manche terminée|score final|revanche/i.test(bodyText) && !/c['’]?est votre tour|à vous de jouer/i.test(bodyText)) return true;
        return false;
    });
}

async function isMatchOver(page) {
    return await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase();
        if (/match terminé|victoire|défaite|match over|you win|you lose/i.test(bodyText)) return true;
        return false;
    });
}

async function waitForMyTurnOrRoundEnd(page, timeout = 28000) {
    console.log('⏳ Attente de mon tour...');
    const start = Date.now();
    while (Date.now() - start < timeout) {
        await killChromePopups(page);
        if (await isRoundOver(page)) return 'round_over';
        const myTurn = await page.evaluate(() => {
            return /c['’]?est votre tour/i.test(document.body.innerText) || /à vous de jouer/i.test(document.body.innerText);
        });
        if (myTurn) { console.log('🔔 Mon tour !'); return 'my_turn'; }
        await delay(1000);
    }
    return 'timeout';
}

// --- Dashboard ---
async function extractFullGameState(page) {
    return await page.evaluate(() => {
        const hand = [...document.querySelectorAll('.domino:not(.domino_board .domino)')].map(d => {
            const left = d.querySelector('.domino_left');
            const right = d.querySelector('.domino_right');
            return {
                left: left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?',
                right: right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?',
                playable: d.classList.contains('cursor_pointer')
            };
        });
        const board = [...document.querySelectorAll('.domino_board .domino')].map(d => {
            const left = d.querySelector('.domino_left');
            const right = d.querySelector('.domino_right');
            return {
                left: left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?',
                right: right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?'
            };
        });
        const bodyText = document.body.innerText.toLowerCase();
        return {
            hand, board,
            isMyTurn: /c['’]?est votre tour|à vous de jouer/i.test(bodyText),
            isRoundOver: /prochain round|manche terminée|a gagné/i.test(bodyText),
            isMatchOver: /match terminé|victoire|défaite/i.test(bodyText),
            myHandCount: hand.length,
            boardCount: board.length,
            lastUpdate: new Date().toLocaleString('fr-FR'),
            timestamp: Date.now()
        };
    });
}

function saveGameState(state) {
    try {
        fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(state, null, 2));
    } catch (err) {}
}

// --- Jouer une manche ---
async function playOneRound(page, roundNumber) {
    console.log(`\n🎲 Début de la manche ${roundNumber}`);
    await delay(3000);
    playedDominoes.clear();
    let consecutiveMisses = 0;
    let failedValues = new Set();

    while (true) {
        try {
            const state = await extractFullGameState(page);
            saveGameState(state);
        } catch (e) {}

        const waitResult = await waitForMyTurnOrRoundEnd(page);
        if (waitResult === 'round_over') { console.log('🏁 Manche terminée.'); break; }
        if (waitResult === 'timeout') {
            consecutiveMisses++;
            if (consecutiveMisses >= 5) { console.log('⚠️ Trop de tours manqués, fin de manche.'); break; }
            await delay(2000);
            continue;
        }

        consecutiveMisses = 0;
        if (await isRoundOver(page)) { console.log('🏁 Fin de manche.'); break; }

        const fullHand = await getFullHand(page);
        console.log(`🃏 Main : ${fullHand.length} dominos`);

        const result = await playTurn(page, fullHand.length, failedValues);
        if (result.status === 'failed' && result.failedValue) {
            failedValues.add(result.failedValue);
            if (failedValues.size >= 3) failedValues.clear();
        }

        await delay(1000);
    }

    try {
        const state = await extractFullGameState(page);
        saveGameState(state);
    } catch (e) {}
}

// --- Principal ---
async function main() {
    console.log('🚀 Démarrage du bot kitabo...');
    console.log(`📱 ${phone} | Score: ${desiredScore} | Mise: ${desiredMise}`);

    const { browser, page } = await connect({
        headless: false,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu'
        ],
        turnstile: true,
        connectOption: { defaultViewport: { width: 1280, height: 720 } }
    });

    console.log('✅ Navigateur lancé');

    try {
        // Aller sur GoodLoka
        await page.goto('https://goodloka.com', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('📄 Page chargée');
        await delay(3000);

        // Screenshot pour debug
        await page.screenshot({ path: path.join(screenshotsDir, 'page_accueil.png') });
        console.log('📸 Screenshot sauvegardé');

        // Chercher et remplir les champs de connexion
        console.log('🔍 Recherche des champs de connexion...');

        // Chercher tous les inputs
        const inputs = await page.$$('input');
        console.log(`📋 ${inputs.length} inputs trouvés`);

        for (const input of inputs) {
            const type = await input.evaluate(el => el.type);
            const name = await input.evaluate(el => el.name);
            const placeholder = await input.evaluate(el => el.placeholder);
            console.log(`   Input: type=${type}, name=${name}, placeholder=${placeholder}`);
        }

        // Essayer de remplir le téléphone
        let filled = false;
        for (const selector of ['input[type="tel"]', 'input[name="phone"]', 'input[placeholder*="phone"]', 'input[placeholder*="téléphone"]', 'input[placeholder*="numéro"]']) {
            try {
                await page.waitForSelector(selector, { timeout: 3000 });
                await fillFieldHuman(page, selector, phone, 'Téléphone');
                filled = true;
                console.log(`✅ Téléphone rempli avec: ${selector}`);
                break;
            } catch (e) {}
        }
        if (!filled) {
            // Prendre tous les inputs visibles et remplir le premier
            const visibleInputs = await page.$$('input:not([type="hidden"])');
            if (visibleInputs.length >= 1) {
                await visibleInputs[0].click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await page.keyboard.type(phone, { delay: 50 });
                console.log('✅ Téléphone rempli (fallback)');
            }
        }

        // Essayer de remplir le mot de passe
        filled = false;
        for (const selector of ['input[type="password"]', 'input[name="password"]']) {
            try {
                await page.waitForSelector(selector, { timeout: 3000 });
                await fillFieldHuman(page, selector, password, 'Mot de passe');
                filled = true;
                console.log(`✅ Mot de passe rempli avec: ${selector}`);
                break;
            } catch (e) {}
        }
        if (!filled) {
            const visibleInputs = await page.$$('input:not([type="hidden"])');
            if (visibleInputs.length >= 2) {
                await visibleInputs[1].click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await page.keyboard.type(password, { delay: 50 });
                console.log('✅ Mot de passe rempli (fallback)');
            }
        }

        // Cliquer sur connexion
        const loginBtn = await findButtonByText(page, 'Se connecter');
        if (loginBtn) {
            await loginBtn.click();
            console.log('🔑 Bouton connexion cliqué');
        } else {
            console.log('⚠️ Bouton connexion non trouvé, tentative Enter');
            await page.keyboard.press('Enter');
        }

        await delay(5000);
        await page.screenshot({ path: path.join(screenshotsDir, 'apres_connexion.png') });
        console.log('📸 Screenshot après connexion');

        // Boucle de jeu
        let roundNumber = 1;
        while (true) {
            if (await isMatchOver(page)) { console.log('🏆 Match terminé !'); break; }
            await playOneRound(page, roundNumber);
            roundNumber++;
            await delay(10000);
        }

    } catch (error) {
        console.error('❌ Erreur:', error.message);
    } finally {
        console.log('🛑 Fermeture du navigateur...');
        await browser.close();
    }
}

main();
