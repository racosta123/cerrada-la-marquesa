importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
// Estos valores son públicos (mismos del config.js).
firebase.initializeApp({
  apiKey: "AIzaSyDdaoq9bZdx0RxpDQB_meakGBwopwaPx5s",
  authDomain: "cerrada-la-marquesa.firebaseapp.com",
  projectId: "cerrada-la-marquesa",
  messagingSenderId: "67754183430",
  appId: "1:67754183430:web:ee3937802e9f4920c3ac87",
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage(p => {
  self.registration.showNotification(p.notification?.title || 'Cerrada La Marquesa', {
    body: p.notification?.body || '', icon: 'icons/icon-192.png',
  });
});
