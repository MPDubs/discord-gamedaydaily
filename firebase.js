// firebase.js
const admin = require('firebase-admin');
const serviceAccount = require('./gamedaydaily-b98a9-firebase-adminsdk-xjkcu-7aaff15be1.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://your-project-id.firebaseio.com"
});

const db = admin.firestore();
module.exports = db;