// ============================================================
// HOT TAKE — serveur temps réel (Node.js + Socket.io)
// ============================================================
// Ce serveur fait AUTORITÉ sur l'état de chaque partie : les
// clients ne font que proposer des actions, le serveur décide.
// ============================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // à restreindre en prod à ton domaine client
});

const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// État en mémoire : { CODE: Room }
// ------------------------------------------------------------
const rooms = {};

const DEFAULT_SETTINGS = {
  threshold: 70, // % de bonnes réponses nécessaire pour révéler
  guessTimeSeconds: 25, // durée d'une manche de devinette
};

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sans lettres ambiguës
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function makeRoom(hostSocketId) {
  return {
    hostId: hostSocketId,
    players: [], // { id, name, submitted: bool }
    settings: { ...DEFAULT_SETTINGS },
    phase: "lobby", // lobby | writing | guessing | round_result | recap
    hotTakes: [], // { authorId, authorName, text, guesses: {guesserId: guessedId}, revealed, correctCount, totalVoters }
    currentIndex: -1,
    roundTimer: null,
  };
}

function publicPlayers(room) {
  return room.players.map((p) => ({ id: p.id, name: p.name, submitted: p.submitted }));
}

function publicRoomState(room, code) {
  return {
    code,
    phase: room.phase,
    players: publicPlayers(room),
    settings: room.settings,
    currentIndex: room.currentIndex,
    totalTakes: room.hotTakes.length,
  };
}

function broadcastState(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("room_state", publicRoomState(room, code));
}

function findPlayer(room, socketId) {
  return room.players.find((p) => p.id === socketId);
}

// Mélange Fisher-Yates
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------
// Logique des manches
// ------------------------------------------------------------
function startGuessingPhase(code) {
  const room = rooms[code];
  room.phase = "guessing";
  room.hotTakes = shuffle(
    room.hotTakes.map((t) => ({ ...t, guesses: {}, revealed: false }))
  );
  room.currentIndex = 0;
  broadcastCurrentTake(code);
}

function broadcastCurrentTake(code) {
  const room = rooms[code];
  const take = room.hotTakes[room.currentIndex];
  const deadline = Date.now() + room.settings.guessTimeSeconds * 1000;

  io.to(code).emit("new_take", {
    index: room.currentIndex,
    total: room.hotTakes.length,
    text: take.text,
    players: publicPlayers(room), // pour construire la liste de choix
    deadline,
  });

  broadcastState(code);

  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => resolveCurrentTake(code), room.settings.guessTimeSeconds * 1000);
}

function resolveCurrentTake(code) {
  const room = rooms[code];
  if (!room || room.phase !== "guessing") return;
  clearTimeout(room.roundTimer);

  const take = room.hotTakes[room.currentIndex];
  const voters = room.players.filter((p) => p.id !== take.authorId);
  const totalVoters = voters.length;
  const correctCount = voters.filter((p) => take.guesses[p.id] === take.authorId).length;
  const pct = totalVoters === 0 ? 0 : Math.round((correctCount / totalVoters) * 100);
  const revealed = pct >= room.settings.threshold;

  take.revealed = revealed;
  take.correctCount = correctCount;
  take.totalVoters = totalVoters;
  take.percentage = pct;

  room.phase = "round_result";

  io.to(code).emit("round_result", {
    index: room.currentIndex,
    text: take.text,
    percentage: pct,
    threshold: room.settings.threshold,
    revealed,
    authorName: revealed ? take.authorName : null,
    guesses: take.guesses, // {guesserId: guessedId} — le client peut afficher qui a voté quoi
  });

  broadcastState(code);
}

function nextTakeOrRecap(code) {
  const room = rooms[code];
  if (!room) return;

  if (room.currentIndex + 1 >= room.hotTakes.length) {
    room.phase = "recap";
    io.to(code).emit("game_recap", {
      takes: room.hotTakes.map((t) => ({
        text: t.text,
        revealed: t.revealed,
        authorName: t.revealed ? t.authorName : null,
        percentage: t.percentage,
      })),
    });
    broadcastState(code);
  } else {
    room.currentIndex += 1;
    room.phase = "guessing";
    broadcastCurrentTake(code);
  }
}

// ------------------------------------------------------------
// Sockets
// ------------------------------------------------------------
io.on("connection", (socket) => {
  // --- Création de salon ---
  socket.on("create_room", ({ name }, cb) => {
    const code = generateRoomCode();
    const room = makeRoom(socket.id);
    room.players.push({ id: socket.id, name: (name || "Hôte").trim().slice(0, 20), submitted: false });
    rooms[code] = room;
    socket.join(code);
    socket.data.code = code;
    cb?.({ ok: true, code, state: publicRoomState(room, code) });
    broadcastState(code);
  });

  // --- Rejoindre un salon ---
  socket.on("join_room", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: "Ce salon n'existe pas." });
    if (room.phase !== "lobby") return cb?.({ ok: false, error: "La partie a déjà commencé." });
    if (room.players.some((p) => p.name.toLowerCase() === (name || "").toLowerCase().trim())) {
      return cb?.({ ok: false, error: "Ce prénom est déjà pris dans ce salon." });
    }

    room.players.push({ id: socket.id, name: (name || "Joueur").trim().slice(0, 20), submitted: false });
    socket.join(code);
    socket.data.code = code;
    cb?.({ ok: true, code, state: publicRoomState(room, code) });
    broadcastState(code);
  });

  // --- Modifier les réglages (hôte uniquement) ---
  socket.on("update_settings", ({ threshold, guessTimeSeconds }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.phase !== "lobby") return;
    if (Number.isFinite(threshold)) room.settings.threshold = Math.min(100, Math.max(1, threshold));
    if (Number.isFinite(guessTimeSeconds)) room.settings.guessTimeSeconds = Math.min(120, Math.max(5, guessTimeSeconds));
    broadcastState(code);
  });

  // --- Démarrer la partie (hôte uniquement) ---
  socket.on("start_game", () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) return; // minimum recommandé pour que ce soit fun
    room.phase = "writing";
    room.hotTakes = [];
    room.players.forEach((p) => (p.submitted = false));
    broadcastState(code);
  });

  // --- Soumettre sa hot take ---
  socket.on("submit_take", ({ text }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.phase !== "writing") return;
    const player = findPlayer(room, socket.id);
    if (!player || player.submitted) return;

    const clean = (text || "").trim().slice(0, 280);
    if (!clean) return;

    player.submitted = true;
    room.hotTakes.push({ authorId: player.id, authorName: player.name, text: clean, guesses: {}, revealed: false });

    broadcastState(code);

    if (room.players.every((p) => p.submitted)) {
      startGuessingPhase(code);
    }
  });

  // --- Soumettre une devinette ---
  socket.on("submit_guess", ({ guessedPlayerId }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.phase !== "guessing") return;
    const take = room.hotTakes[room.currentIndex];
    if (!take) return;
    if (socket.id === take.authorId) return; // l'auteur ne devine pas sur lui-même

    take.guesses[socket.id] = guessedPlayerId;

    const voters = room.players.filter((p) => p.id !== take.authorId);
    if (voters.every((p) => take.guesses[p.id] !== undefined)) {
      resolveCurrentTake(code);
    }
  });

  // --- Passer à la take suivante (hôte, après le résultat) ---
  socket.on("next_round", () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.phase !== "round_result") return;
    nextTakeOrRecap(code);
  });

  // --- Rejouer (retour au lobby) ---
  socket.on("play_again", () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    room.phase = "lobby";
    room.hotTakes = [];
    room.currentIndex = -1;
    room.players.forEach((p) => (p.submitted = false));
    broadcastState(code);
  });

  // --- Déconnexion ---
  socket.on("disconnect", () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== socket.id);

    if (room.players.length === 0) {
      clearTimeout(room.roundTimer);
      delete rooms[code];
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id; // transfert de l'hôte
    }

    broadcastState(code);
  });
});

app.get("/", (_req, res) => res.send("Serveur Hot Take en ligne."));

server.listen(PORT, () => console.log(`Hot Take server running on port ${PORT}`));
