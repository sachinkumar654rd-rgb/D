const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const { 
    getFirestore, doc, setDoc, getDocs, 
    collection, getDoc, deleteDoc
} = require('firebase/firestore');

// --- Configuration ---
const BOT_TOKEN = '8646935592:AAFFV3kTtLXXt0iLPfgvugIE9mjdQ1fvcy8';
const CHANNEL_ID = '-1003783195321'; 
const APP_ID = "prediction-bot-19138"; 
const MAX_HISTORY = 20000; 

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

async function fetchSafeData() {

    try {

        const proxy =
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent("https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=10")}`;

        const res = await axios.get(proxy,{ timeout:15000 });

        if(res.data?.data?.list){
            return res.data.data.list;
        }

    } catch(e){
        console.log("Proxy Failed");
    }

    return null;
}

async function getAIPrediction(currentSeq, fullHistory) {
    if (!fullHistory || fullHistory.length < 10) return { r: Math.random() > 0.5 ? "BIG" : "SMALL", l: "INIT", n: "?" };
    const winHistory = fullHistory.map(h => parseInt(h.number));
    
    for (let len = 9; len >= 2; len--) {
        const patternToSearch = currentSeq.slice(0, len);
        for (let i = 1; i <= winHistory.length - len - 1; i++) {
            const window = winHistory.slice(i, i + len);
            const isMatch = window.every((val, idx) => val === patternToSearch[idx]);
            if (isMatch) {
                const predNum = winHistory[i - 1]; 
                return { r: predNum >= 5 ? "BIG" : "SMALL", n: predNum, l: len };
            }
        }
    }
    const last10 = winHistory.slice(0, 10);
    const bigs = last10.filter(n => n >= 5).length;
    return { r: bigs >= 5 ? "BIG" : "SMALL", n: "?", l: "MAJ" };
}

async function loop() {
    try {
        const list = await fetchSafeData();
        if (!list || list.length === 0) {
            console.log("No data received from API.");
            return;
        }

        // Sync Data
        for (let item of list) {
            const id = (item.issueNumber || item.period)?.toString();
            const num = parseInt(item.number || item.result);
            if (!id || isNaN(num)) continue;
            await setDoc(doc(db, 'history_v2', id), { issueNumber: id, number: num, timestamp: Date.now() }, { merge: true });
        }

        // Fetch Sorted History
        const snap = await getDocs(collection(db, 'history_v2'));
        let history = [];
        snap.forEach(d => history.push(d.data()));
        history.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));

        if (history.length === 0) return;

        // Auto Cleanup
        if (history.length > MAX_HISTORY) {
            const toDel = history.slice(MAX_HISTORY);
            for (let old of toDel) await deleteDoc(doc(db, 'history_v2', old.issueNumber));
        }

        const latest = history[0];
        if (!latest || !latest.issueNumber) return;

        // BigInt Error Fix: Pehle check karein ki issueNumber valid hai
        const nextPeriodId = (BigInt(latest.issueNumber) + 1n).toString();
        
        const stateRef = doc(db, 'system', 'state_v2');
        const stateSnap = await getDoc(stateRef);
        const state = stateSnap.exists() ? stateSnap.data() : {};

        // Edit Result
        if (state.issueNumber === latest.issueNumber && !state.done) {
            const actual = latest.number >= 5 ? "BIG" : "SMALL";
            const won = state.prediction === actual;
            const resMsg = `📊 *AI RESULT UPDATE*\n━━━━━━━━━━━━━━\n🆔 *Period:* \`#${latest.issueNumber.slice(-4)}\`\n🎲 *Pred:* ${state.prediction}\n🎯 *Res:* ${actual} (${latest.number})\n🏆 *Status:* ${won ? "✅ WIN" : "❌ LOSS"}\n✨ *Match:* L-${state.level}`;
            try {
                await bot.telegram.editMessageText(CHANNEL_ID, state.msgId, null, resMsg, { parse_mode: 'Markdown' });
                await setDoc(stateRef, { done: true }, { merge: true });
            } catch (e) { console.log("Edit failed"); }
        }

        // New Prediction
        if (state.issueNumber !== nextPeriodId) {
            const currentSeq = history.slice(0, 10).map(h => h.number);
            const ai = await getAIPrediction(currentSeq, history);
            
            const predText = `🎯 *AI PATTERN PREDICTION*\n━━━━━━━━━━━━━━\n🆔 *Period:* \`#${nextPeriodId.slice(-4)}\`\n🎲 *Prediction:* **${ai.r}**\n📊 *Match Length:* ${ai.l}\n🔢 *Pred Number:* ${ai.n}\n⏳ *Scan Size:* \`${history.length}\` / 20k\n━━━━━━━━━━━━━━`;
            
            try {
                const s = await bot.telegram.sendMessage(CHANNEL_ID, predText, { parse_mode: 'Markdown' });
                await setDoc(stateRef, {
                    issueNumber: nextPeriodId,
                    prediction: ai.r,
                    level: ai.l,
                    msgId: s.message_id,
                    done: false
                });
            } catch (e) { console.log("Telegram send failed"); }
        }
    } catch (err) { 
        console.error("Loop Error Managed:", err.message); 
    }
}

bot.command('history', async (ctx) => {
    try {
        const snap = await getDocs(collection(db, 'history_v2'));
        let h = []; snap.forEach(d => h.push(d.data()));
        h.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));
        let res = "📊 *Recent Database Logs*\n\n";
        h.slice(0, 30).reverse().forEach(i => {
            res += `\`${i.issueNumber.slice(-4)}\` -> ${i.number} (${i.number >= 5 ? "B" : "S"})\n`;
        });
        ctx.replyWithMarkdown(res + `\nTotal Records: ${h.length}`);
    } catch (e) { ctx.reply("History fetch error."); }
});

const app = express();
app.get('/', (req, res) => res.send('Pattern AI Engine V2 Fixed'));
app.listen(process.env.PORT || 3000);

setInterval(loop, 35000);
loop();

bot.launch({ dropPendingUpdates: true });
