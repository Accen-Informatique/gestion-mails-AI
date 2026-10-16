// Client Data API FileMaker (fmrestapi) — même fonctionnement que core/FileMaker.js des autres projets Accen :
// mêmes méthodes, même retour { code, message, data } (code '0' = OK), certificat auto-signé accepté
// tant que IS_PRODUCTION est faux. Version promesse (async/await) au lieu des callbacks, sans
// la librairie « request » (abandonnée) : https natif de Node.
import https from 'node:https';
import http from 'node:http';
import { config } from './config.js';

export default class FileMaker {
  constructor(db) {
    this.URL = `${config.filemaker.host.replace(/\/$/, '')}/fmi/data/v1/databases/${encodeURIComponent(db)}`;
    // false = certificat du serveur non vérifié (serveur interne, certificat auto-signé)
    this.IS_PRODUCTION = config.filemaker.verifierCertificat;
  }

  // auth = en-tête complet « Basic xxxx » (comme config.fmpwd)
  async login(auth) {
    const r = await this.appel('POST', '/sessions', { auth, body: {} });
    return r.code == 0 ? { code: '0', message: 'OK', data: r.data.token } : r;
  }

  logout(token) {
    return this.appel('DELETE', `/sessions/${token}`);
  }

  createRecord(token, layout, data, portaldata = {}, script = '') {
    const body = { fieldData: data, portalData: portaldata, ...(script ? { script } : {}) };
    return this.appel('POST', `/layouts/${encodeURIComponent(layout)}/records`, { token, body });
  }

  editRecords(token, layout, idrecord, data, portaldata = {}, script = '') {
    const body = { fieldData: data, portalData: portaldata, ...(script ? { script } : {}) };
    return this.appel('PATCH', `/layouts/${encodeURIComponent(layout)}/records/${idrecord}`, { token, body });
  }

  getRecords(token, layout, start, limit) {
    return this.appel('GET', `/layouts/${encodeURIComponent(layout)}/records?_offset=${start}&_limit=${limit}`, { token });
  }

  getRecord(token, layout, idrecord) {
    return this.appel('GET', `/layouts/${encodeURIComponent(layout)}/records/${idrecord}`, { token });
  }

  findRecords(token, layout, query, sort = [], limit = 1000) {
    const body = { query, offset: '1', limit, ...(sort.length ? { sort } : {}) };
    return this.appel('POST', `/layouts/${encodeURIComponent(layout)}/_find`, { token, body });
  }

  runScript(token, layout, idrecord, script, param) {
    const qs = `script=${encodeURIComponent(script)}&script.param=${encodeURIComponent(param ?? '')}`;
    return this.appel('GET', `/layouts/${encodeURIComponent(layout)}/records/${idrecord}?${qs}`, { token });
  }

  // Requête HTTP → { code, message, data } ; erreur réseau → code '-1'
  appel(method, chemin, { token, auth, body } = {}) {
    const url = new URL(this.URL + chemin);
    const contenu = body === undefined ? null : JSON.stringify(body);
    const client = url.protocol === 'http:' ? http : https;
    return new Promise(resolve => {
      const req = client.request(url, {
        method,
        rejectUnauthorized: this.IS_PRODUCTION,
        timeout: config.filemaker.delaiSecondes * 1000, // évite un blocage si le serveur ne répond plus
        headers: {
          'cache-control': 'no-cache',
          ...(contenu !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(contenu) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(auth ? { authorization: auth } : {}),
        },
      }, res => {
        let brut = '';
        res.setEncoding('utf8');
        res.on('data', c => (brut += c));
        res.on('end', () => {
          try {
            const info = JSON.parse(brut);
            const msg = info.messages?.[0] || {};
            resolve(msg.code == 0
              ? { code: '0', message: 'OK', data: info.response }
              : { code: String(msg.code ?? res.statusCode), message: msg.message || res.statusMessage, data: '' });
          } catch {
            resolve({ code: '-1', message: `Réponse illisible (HTTP ${res.statusCode})`, data: '' });
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('délai dépassé')));
      req.on('error', e => resolve({ code: '-1', message: `Erreur interne : ${e.message}`, data: '' }));
      if (contenu !== null) req.write(contenu);
      req.end();
    });
  }
}
