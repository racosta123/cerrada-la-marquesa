/* Copia este archivo como config.js y rellena con tus valores reales.
   config.js NO debe contener secretos del Worker ni de la Shelly. */
const CONFIG = {
  firebase: {
    apiKey: "AIzaSyDdaoq9bZdx0RxpDQB_meakGBwopwaPx5s",       // RESTRINGIR a racosta123.github.io en Google Cloud Console
    authDomain: "cerrada-la-marquesa.firebaseapp.com",
    projectId: "cerrada-la-marquesa",
    storageBucket: "cerrada-la-marquesa.firebasestorage.app",
    messagingSenderId: "67754183430",
    appId: "1:67754183430:web:ee3937802e9f4920c3ac87",
  },
  workerUrl: "https://la-marquesa-proxy.acosta4770.workers.dev",
  appCheckSiteKey: "",  // App Check — pendiente: pega aquí tu reCAPTCHA v3 site key real
  vapidKey: "",         // FCM Web Push — pendiente: pega aquí tu clave pública VAPID real
};
