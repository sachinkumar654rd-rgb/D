const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const { 
    getFirestore, doc, setDoc, getDocs, 
    collection, getDoc, deleteDoc, query, orderBy, limit 
} = require('firebase/firestore');

// --- Configuration ---
const BOT_TOKEN = '8646935592:AAFFV3kTtLXXt0iLPfgvugIE9mjdQ1fvcy8';
const CHANNEL_ID = '-1003783195321'; 
const APP_ID = "prediction-bot-19138"; 
const MAX_HISTORY = 20000; // Aapke doc ke mutabiq max limit

const firebaseConfig = {
  apiKey: "AIzaSyD6voprtvighK-ZPX8NpZ8xUYWOFW2PeII",
  authDomain: "prediction-bot-19138.firebaseapp.com",
  projectId: "prediction-bot-19138",
  storageBucket: "prediction-bot-19138.firebasestorage.app",
  messagingSenderId: "1057783234759",
  appId: "1:1057783234759:web:3f1d85fa16b0fb3a58fee2",
  measurementId: "G-Q569JVQ9YY"
};

const firebaseApp = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(firebaseApp);
const bot = new Telegraf(BOT_TOKEN);

/**
 * Data Fetching with Proxy (To avoid 403)
 */
async function fetchSafeData() {

    try {

        const proxy = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent("https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=10")}`;

        const res = await axios.get(proxy, { timeout: 15000 });

        if (res.data?.data?.list) {
            return res.data.data.list;
        }

    } catch (e) {
        console.log("Proxy 2 Failed");
    }

    return null;

}

/**
 * Core Logic: Pattern Matching (Point 6-9 of your Doc)
 */
async function getAIPrediction(currentSeq, fullHistory) {
    if (fullHistory.length < 20) return { r: "WAIT", l: 0 };

    const winHistory = fullHistory.map(h => parseInt(h.number));
    
    // Pattern Search: L9 down to L2
    for (let len = 9; len >= 2; len--) {
        const patternToSearch = currentSeq.slice(0, len);
        
        // History scan (Descending: 0 is newest)
        for (let i = 1; i <= winHistory.length - len - 1; i++) {
            const window = winHistory.slice(i, i + len);
            const isMatch = window.every((val, idx) => val === patternToSearch[idx]);
            
            if (isMatch) {
                // Prediction is the number ABOVE the matched pattern (index i-1)
                const predNum = winHistory[i - 1];
                const bigSmall = predNum >= 5 ? "BIG" : "SMALL";
                return { r: bigSmall, n: predNum, l: len };
            }
        }
    }

    // Default Fallback: Last 10 Majority
    const last10 = winHistory.slice(0, 10);
    const bigs = last10.filter(n => n >= 5).length;
    return { r: bigs >= 5 ? "BIG" : "SMALL", n: "?", l: "MAJ" };
}

async function loop() {
    try {
        const list = await fetchSafeData();
        if (!list) return;

        // 1. Sync & Store (Firebase)
        for (let item of list) {
            const id = (item.issueNumber || item.period).toString();
            const num = parseInt(item.number || item.result);
            await setDoc(doc(db, 'history', id), { 
                issueNumber: id, number: num, timestamp: Date.now() 
            }, { merge: true });
        }

        // 2. Load Sorted History
        const snap = await getDocs(collection(db, 'history'));
        let history = [];
        snap.forEach(d => history.push(d.data()));
        history.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));

        // 3. Auto Cleanup (Max 20,000)
        if (history.length > MAX_HISTORY) {
            const toDel = history.slice(MAX_HISTORY);
            for (let old of toDel) await deleteDoc(doc(db, 'history', old.issueNumber));
        }

        const latest = history[0];
        const nextPeriodId = (BigInt(latest.issueNumber) + 1n).toString();
        
        const stateRef = doc(db, 'system', 'bot_state');
        const stateSnap = await getDoc(stateRef);
        const state = stateSnap.exists() ? stateSnap.data() : {};

        // 4. Result Check & Message Update (Point 12-13)
        if (state.issueNumber === latest.issueNumber && !state.done) {
            const actualBS = latest.number >= 5 ? "BIG" : "SMALL";
            const isWin = state.prediction === actualBS;
            const editMsg = `📊 *AI RESULT UPDATE*\n━━━━━━━━━━━━━━\n🆔 *Period:* \`#${latest.issueNumber.slice(-4)}\`\n🎲 *Pred:* ${state.prediction}\n🎯 *Res:* ${actualBS} (${latest.number})\n🏆 *Status:* ${isWin ? "✅ WIN" : "❌ LOSS"}\n✨ *Match:* L-${state.level}`;
            
            try {
                await bot.telegram.editMessageText(CHANNEL_ID, state.msgId, null, editMsg, { parse_mode: 'Markdown' });
                await setDoc(stateRef, { done: true }, { merge: true });
            } catch (e) {}
        }

        // 5. New Prediction (Point 11)
        if (state.issueNumber !== nextPeriodId) {
            const currentSeq = history.slice(0, 10).map(h => h.number);
            const ai = await getAIPrediction(currentSeq, history);

            const predText = `🎯 *AI PATTERN PREDICTION*\n━━━━━━━━━━━━━━\n🆔 *Period:* \`#${nextPeriodId.slice(-4)}\`\n🎲 *Prediction:* **${ai.r}**\n📊 *Match Length:* ${ai.l}\n🔢 *Pred Number:* ${ai.n}\n⏳ *Scan Size:* \`${history.length}\`\n━━━━━━━━━━━━━━`;
            
            try {
                const s = await bot.telegram.sendMessage(CHANNEL_ID, predText, { parse_mode: 'Markdown' });
                await setDoc(stateRef, {
                    issueNumber: nextPeriodId,
                    prediction: ai.r,
                    level: ai.l,
                    msgId: s.message_id,
                    done: false
                });
            } catch (e) {}
        }
    } catch (err) { console.error("Loop Error:", err.message); }
}

// History Command
bot.command('history', async (ctx) => {
    try {
        const snap = await getDocs(collection(db, 'history'));
        let h = []; snap.forEach(d => h.push(d.data()));
        h.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));
        let res = "📖 *Database History (Recent 30)*\n\n";
        h.slice(0, 30).forEach(i => {
            res += `\`${i.issueNumber.slice(-4)}\` -> ${i.number} (${i.number >= 5 ? "B" : "S"})\n`;
        });
        ctx.replyWithMarkdown(res + `\nTotal Records: ${h.length}`);
    } catch (e) { ctx.reply("Error loading history."); }
});

const app = express();
app.get('/', (req, res) => res.send('AI Pattern Engine Active'));
app.listen(process.env.PORT || 3000);

setInterval(loop, 30000);
loop();

bot.launch({ dropPendingUpdates: true });
console.log("System started with Full Pattern Logic.");
