require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, EmbedBuilder, Colors, PermissionFlagsBits } = require('discord.js');
const http = require('http');
const db = require('./database');
const { fmt, netSalary } = require('./utils/economy');
const { syncSalary } = require('./utils/supabaseSync');

// ── Init DB ──────────────────────────────────────────────────────────────────
db.init();

// Clean expired pending verifications every 5 minutes
setInterval(() => db.cleanExpiredPending(), 5 * 60 * 1000);

// ── HTTP server para recibir códigos del plugin de Minecraft ──────────────────
const HTTP_PORT = process.env.HTTP_PORT || 3034;
const PLUGIN_SECRET = process.env.BOT_PLUGIN_SECRET || 'cambia_esta_clave_secreta';

const httpServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/mc-verify') {
    // Verificar secreto
    if (req.headers['x-secret'] !== PLUGIN_SECRET) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { username, uuid, code } = JSON.parse(body);
        if (!username || !uuid || !code) {
          res.writeHead(400);
          return res.end('Bad Request');
        }

        // Guardar el código pendiente (expira en 10 minutos)
        const expiresAt = Date.now() + 10 * 60 * 1000;
        db.addMcPending(username, uuid, code, expiresAt);

        console.log(`[MC Verify] Código ${code} generado para ${username}`);
        res.writeHead(200);
        res.end('OK');
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`🌐 Servidor HTTP escuchando en puerto ${HTTP_PORT}`);
});

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Load slash commands ───────────────────────────────────────────────────────
client.slashCommands = new Collection();
const slashFiles = [
  'verify', 'confirm', 'unverify', 'link', 'rankupdate',
  'ban', 'kick', 'timeout', 'untimeout',
  'warn', 'warnings', 'purge', 'slowmode',
  'lock', 'nick', 'announce', 'userinfo', 'role',
  'eco', 'balance', 'pay', 'job', 'shop', 'auction', 'perms', 'inactivos', 'sancionar',
];
for (const file of slashFiles) {
  const cmd = require(`./commands/${file}`);
  client.slashCommands.set(cmd.data.name, cmd);
}

// ── Load mod (prefix) commands ────────────────────────────────────────────────
client.modCommands = new Collection();

const setMod = require('./mod-commands/set');
const massMod = require('./mod-commands/massupdate');
const watchMod = require('./mod-commands/watchlist');
const setupMod = require('./mod-commands/setup');

for (const mod of [setMod, setMod.get, setMod.clear, massMod, massMod.massclean, watchMod, setupMod]) {
  if (mod && mod.name) client.modCommands.set(mod.name, mod);
}

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot listo como ${client.user.tag}`);
  client.user.setActivity('Gestionando la economía del reino');
  startWeeklySalaryScheduler();
  startAuctionScheduler();
});

// ── Weekly salary scheduler ───────────────────────────────────────────────────
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function startWeeklySalaryScheduler() {
  // Check every hour if it's time to pay salaries
  setInterval(() => checkAndPaySalaries(), 60 * 60 * 1000);
  // Also check on startup in case the bot was down during payout
  checkAndPaySalaries();
}

async function checkAndPaySalaries() {
  for (const guild of client.guilds.cache.values()) {
    const lastPaidStr = db.getConfig(guild.id, 'last_salary_payout');
    const lastPaid = lastPaidStr ? parseInt(lastPaidStr) : 0;

    if (Date.now() - lastPaid < WEEK_MS) continue;

    await paySalaries(guild);
    db.setConfig(guild.id, 'last_salary_payout', String(Date.now()));
  }
}

async function paySalaries(guild) {
  const jobs = db.getJobs(guild.id);
  if (!jobs.length) return;

  // Fetch all members
  let members;
  try {
    members = await guild.members.fetch();
  } catch {
    return;
  }

  const payoutDate = new Date().toLocaleDateString('es-ES');
  const paidUsers = new Map(); // discordId -> { gross, tax, net, jobNames }

  for (const job of jobs) {
    const { gross, tax, net } = netSalary(job.salary);
    const membersWithRole = members.filter(m => m.roles.cache.has(job.role_id));

    for (const [, member] of membersWithRole) {
      if (member.user.bot) continue;

      db.addBalance(guild.id, member.id, net, `Salario semanal: ${job.name}`, 'salary');
      syncSalary(member.id, net, job.name, `Salario semanal`);

      if (!paidUsers.has(member.id)) {
        paidUsers.set(member.id, { entries: [], totalGross: 0, totalTax: 0, totalNet: 0 });
      }
      const record = paidUsers.get(member.id);
      record.entries.push({ jobName: job.name, gross, tax, net });
      record.totalGross += gross;
      record.totalTax += tax;
      record.totalNet += net;
    }
  }

  // Send DMs
  for (const [discordId, data] of paidUsers) {
    const balance = db.getBalance(guild.id, discordId).balance;

    const dmEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`💰 Nómina semanal — ${guild.name}`)
      .setDescription(`Aquí tienes el resumen de tus ingresos de esta semana (${payoutDate}):`)
      .addFields(
        ...data.entries.map(e => ({
          name: `💼 ${e.jobName}`,
          value: `Bruto: ${fmt(e.gross)}\nImpuestos (5%): -${fmt(e.tax)}\nNeto: ${fmt(e.net)}`,
          inline: true,
        })),
        { name: '─────────────────', value: '​', inline: false },
        { name: '📥 Total ingresado', value: fmt(data.totalGross), inline: true },
        { name: '🏛️ Total en impuestos', value: `-${fmt(data.totalTax)}`, inline: true },
        { name: '✅ Total neto cobrado', value: fmt(data.totalNet), inline: true },
        { name: '💵 Saldo actual', value: fmt(balance), inline: false },
      )
      .setFooter({ text: `Los impuestos financian el reino · ${guild.name}` })
      .setTimestamp();

    try {
      const user = await client.users.fetch(discordId);
      await user.send({ embeds: [dmEmbed] });
    } catch (_) {}
  }

  console.log(`[Salarios] Pagados a ${paidUsers.size} usuario(s) en ${guild.name}`);
}

// ── Auction scheduler ─────────────────────────────────────────────────────────

function startAuctionScheduler() {
  // Check every 30 seconds for expired auctions
  setInterval(() => processExpiredAuctions(), 30_000);
}

async function processExpiredAuctions() {
  for (const guild of client.guilds.cache.values()) {
    const expired = db.getExpiredAuctions(guild.id);
    for (const auction of expired) {
      db.closeAuction(auction.id, auction.current_bidder ? 'sold' : 'expired');

      if (!auction.current_bidder) continue; // No winner, nothing to charge

      const winner = await client.users.fetch(auction.current_bidder).catch(() => null);
      const seller = await client.users.fetch(auction.seller_id).catch(() => null);

      const winnerAccount = db.getBalance(guild.id, auction.current_bidder);

      // Check if winner still has funds (they could have spent money since bidding)
      if (winnerAccount.balance < auction.current_price) {
        // Notify winner of failure
        if (winner) {
          await winner.send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Red)
                .setTitle('❌ No se pudo completar tu subasta ganada')
                .setDescription(`Ganaste la subasta **#${auction.id} — ${auction.item_name}** con ${fmt(auction.current_price)}, pero ya no tienes suficiente saldo para pagar.`)
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
        continue;
      }

      db.removeBalance(guild.id, auction.current_bidder, auction.current_price, `Subasta ganada: ${auction.item_name}`, 'purchase');
      db.addBalance(guild.id, auction.seller_id, auction.current_price, `Subasta vendida: ${auction.item_name}`, 'sale');

      const newWinnerBalance = db.getBalance(guild.id, auction.current_bidder).balance;
      const newSellerBalance = db.getBalance(guild.id, auction.seller_id).balance;
      const timestamp = new Date().toLocaleString('es-ES');

      // DM ticket al ganador
      if (winner) {
        await winner.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle('🏆 ¡Has ganado la subasta!')
              .setDescription('```\n════════════════════════\n    TICKET DE SUBASTA\n════════════════════════\n```')
              .addFields(
                { name: '🏰 Servidor', value: guild.name, inline: true },
                { name: '📅 Fecha', value: timestamp, inline: true },
                { name: '​', value: '​', inline: false },
                { name: '🔨 Subasta', value: `#${auction.id} — ${auction.item_name}`, inline: true },
                { name: '💰 Precio pagado', value: fmt(auction.current_price), inline: true },
                { name: seller ? '👤 Vendedor' : '​', value: seller ? seller.tag : '​', inline: true },
                { name: '💵 Saldo restante', value: fmt(newWinnerBalance), inline: true },
              )
              .setFooter({ text: '¡Enhorabuena por tu victoria!' })
              .setTimestamp(),
          ],
        }).catch(() => {});
      }

      // DM al vendedor
      if (seller) {
        await seller.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle('🏷️ Tu subasta ha finalizado con éxito')
              .addFields(
                { name: '🔨 Subasta', value: `#${auction.id} — ${auction.item_name}`, inline: true },
                { name: '💰 Ingresado', value: fmt(auction.current_price), inline: true },
                { name: winner ? '🏆 Ganador' : '​', value: winner ? winner.tag : '​', inline: true },
                { name: '💵 Nuevo saldo', value: fmt(newSellerBalance), inline: true },
              )
              .setTimestamp(),
          ],
        }).catch(() => {});
      }

      // Anuncio en el primer canal de texto visible
      try {
        const channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
        if (channel) {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Gold)
                .setTitle(`🏆 Subasta #${auction.id} finalizada`)
                .addFields(
                  { name: 'Artículo', value: auction.item_name, inline: true },
                  { name: '🏆 Ganador', value: `<@${auction.current_bidder}>`, inline: true },
                  { name: '💰 Precio final', value: fmt(auction.current_price), inline: true },
                )
                .setTimestamp(),
            ],
          });
        }
      } catch (_) {}
    }
  }
}

// ── Forzar pago de salarios desde comando ─────────────────────────────────────
client.on('forceSalaryPay', async (guild) => {
  await paySalaries(guild);
  db.setConfig(guild.id, 'last_salary_payout', String(Date.now()));
  console.log(`[Salarios] Pago forzado en ${guild.name}`);
});

// ── Slash command interactions ────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.slashCommands.get(interaction.commandName);
  if (!command) return;

  try {
    // Comprobar permisos personalizados (solo para comandos sin subcomandos)
    // Los comandos con subcomandos gestionan sus propios permisos internamente
    const commandsWithSubcommands = ['eco', 'shop', 'auction', 'job', 'link', 'warnings', 'perms', 'role', 'inactivos'];
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isAdmin && !commandsWithSubcommands.includes(interaction.commandName)) {
      const customPerm = db.hasCustomPermission(interaction.guild.id, interaction.commandName, interaction.member);
      // Si hay permisos configurados (customPerm !== null) y el usuario no los tiene (customPerm === false)
      if (customPerm === false) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Red)
              .setTitle('❌ Sin permiso')
              .setDescription(`No tienes permiso para usar \`/${interaction.commandName}\`.`),
          ],
          ephemeral: true,
        });
      }
    }

    await command.execute(interaction);
  } catch (err) {
    console.error(`Error en /${interaction.commandName}:`, err);
    const errorReply = {
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle('❌ Error inesperado')
          .setDescription('Ocurrió un error al procesar el comando. Por favor, inténtalo de nuevo.'),
      ],
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorReply).catch(() => {});
    } else {
      await interaction.reply(errorReply).catch(() => {});
    }
  }
});

// ── Rastrear actividad ────────────────────────────────────────────────────────
client.on(Events.MessageCreate, (message) => {
  if (message.author.bot || !message.guild) return;
  db.updateActivity(message.guild.id, message.author.id);
});

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.user.bot || !interaction.guild) return;
  // Registrar cualquier interacción (botones, modales, encuestas, slash commands)
  db.updateActivity(interaction.guild.id, interaction.user.id);
});

// ── Prefix (mod) commands ─────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const prefix = db.getConfig(message.guild.id, 'prefix') ?? '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const commandName = args.shift().toLowerCase();

  const command = client.modCommands.get(commandName);
  if (!command) return;

  try {
    await command.execute(message, args);
  } catch (err) {
    console.error(`Error en !${commandName}:`, err);
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle('❌ Error inesperado')
          .setDescription('Ocurrió un error al procesar el comando.'),
      ],
    }).catch(() => {});
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
