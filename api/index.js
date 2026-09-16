/**
 * Vercel Serverless Function — Entry Point
 *
 * Importa e re-exporta o app Express existente.
 * O Vercel trata todo arquivo em /api/ como uma serverless function.
 * Todas as rotas /api/* são encaminhadas para este handler.
 */

import app from "../server/src/index.js";

export default app;
