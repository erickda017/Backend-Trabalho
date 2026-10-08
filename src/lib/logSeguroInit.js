// Importado PRIMEIRO em server.js: qualquer console.* do processo (inclusive de
// módulos que logam já no import) passa por redigir.js antes de sair.
import { instalarLogSeguro } from './redigir.js';
instalarLogSeguro();
