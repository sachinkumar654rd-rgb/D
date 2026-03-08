const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
getFirestore, doc, setDoc, getDocs,
collection, query, limit, getDoc
} = require('firebase/firestore');

// --- Config ---
const BOT_TOKEN = '8646935592:AAFFV3kTtLXXt0iLPfgvugIE9mjdQ1fvcy8';
const CHANNEL_ID = '-1003783195321';

const RENDER_URL = "https://d-ja1q.onrender.com";

// वैकल्पिक API (Tiranga/91Club API - ज़्यादा स्टेबल)
const ALT_API_URL = "https://api.tirangagames.com/api/webapi/GetNoaverageEmerdList";

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

Multi-Source Fetching

अगर मुख्य लिंक ब्लॉक है, तो यह वैकल्पिक लिंक आज़माएगा
*/
async function fetchSafeData() {
// 1. प्रयास: Tiranga Games API (उदाहरण के तौर पर)
try {
const res = await axios.post(ALT_API_URL, {
pageSize: 10,
pageNo: 1,
typeid: 1, // 1 Minute Wingo
language: 0
}, { timeout: 10000 });

if (res.data?.data?.list) return res.data.data.list;

} catch (e) { console.log("Alt API Failed"); }

// 2. प्रयास: मूल API + नई प्रॉक्सी
try {
const proxy = https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent("https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=10")};
const res = await axios.get(proxy, { timeout: 10000 });
if (res.data?.data?.list) return res.data.data.list;
} catch (e) { console.log("Proxy 2 Failed"); }

return null;
}


async function sync() {
const list = await fetchSafeData();
if (list) {
for (let item of list) {
// फील्ड नाम API के हिसाब से बदल सकते हैं (issueNumber या period)
const id = item.issueNumber || item.period;
const num = item.number || item.result;
if(!id) continue;

const docRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'history', id);  
        await setDoc(docRef, {  
            issueNumber: id,  
            number: parseInt(num),  
            timestamp: Date.now()  
        }, { merge: true });  
    }  
    console.log(✅ SYNC SUCCESS: ${list[0].issueNumber || list[0].period});  
    return list;  
}  
console.log("❌ ALL SOURCES BLOCKED. Host IP is blacklisted.");  
return null;

}

// Prediction Logic
async function predict(seq) {
const snap = await getDocs(collection(db, 'artifacts', APP_ID, 'public', 'data', 'history'));
let hist = [];
snap.forEach(d => hist.push(d.data()));
hist.sort((a,b) => Number(b.issueNumber) - Number(a.issueNumber));
const nums = hist.map(h => h.number);

if (nums.length < 3) return { r: "WAIT", l: 0, c: nums.length };  

for (let L = 5; L >= 2; L--) {  
    const p = seq.slice(0, L);  
    for (let i = 1; i < nums.length - L; i++) {  
        let m = true;  
        for (let j=0; j<L; j++) { if (nums[i+j] !== p[j]) { m = false; break; } }  
        if (m) return { r: nums[i-1] >= 5 ? "BIG" : "SMALL", l: L, c: nums.length };  
    }  
}  
return { r: Math.random() > 0.5 ? "BIG" : "SMALL", l: "AI", c: nums.length };

}

let lastP = "";

async function loop() {
const list = await sync();
if (!list) return;

const top = list[0];  
const cur = top.issueNumber || top.period;  
const nxt = (BigInt(cur) + 1n).toString();  

const stateRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'last_pred', 'state');  
const stateSnap = await getDoc(stateRef);

if (stateSnap.exists()) {
const d = stateSnap.data();
if (d.issueNumber === cur && !d.done) {
const resVal = top.number || top.result;
const act = parseInt(resVal) >= 5 ? "BIG" : "SMALL";
const isW = d.prediction === act;
const msg = 🆔 Period: #${cur.slice(-4)}\n🎲 Pred: ${d.prediction}\n🎯 Res: ${act} (${resVal})\n📊 Status: ${isW ? "✅ WIN" : "❌ LOSS"}\n✨ Lvl: L-${d.level};
try {
await bot.telegram.editMessageText(CHANNEL_ID, d.msgId, null, msg, { parse_mode: 'Markdown' });
await setDoc(stateRef, { done: true }, { merge: true });
} catch (e) {}
}
}

if (lastP !== cur) {  
    lastP = cur;  
    const ai = await predict(list.slice(0,5).map(x => parseInt(x.number || x.result)));  
    const txt = 🎯 *MULTI-SYNC PRO*\n━━━━━━━━━━━━━━\n🆔 *Period:* \#${nxt.slice(-4)}\\n🎲 *Prediction:* **${ai.r}**\n📊 *Match:* L-${ai.l}\n⏳ *Status:* Live Tracking...\n━━━━━━━━━━━━━━\nDB Size: \${ai.c}\``;  
    try {  
        const s = await bot.telegram.sendMessage(CHANNEL_ID, txt, { parse_mode: 'Markdown' });  
        await setDoc(stateRef, { issueNumber: nxt, prediction: ai.r, level: ai.l, msgId: s.message_id, done: false });  
    } catch (e) {}  
}

}

const app = express();
app.get('/', (req, res) => res.send('System Online - Hybrid Sync'));
app.listen(process.env.PORT || 3000, () => {
setInterval(() => axios.get(RENDER_URL).catch(e => {}), 600000);
});

setInterval(loop, 40000);
loop();

bot.launch({ dropPendingUpdates: true });

Is code me kaya galti ha
