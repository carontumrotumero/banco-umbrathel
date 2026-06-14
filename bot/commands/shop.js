const {
  SlashCommandBuilder, EmbedBuilder, Colors, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const db = require('../database');
const { syncShopListing, deactivateShopListing } = require('../utils/supabaseSync');
const { fmt } = require('../utils/economy');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Tienda del servidor')
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Ver todos los artículos en venta')
    )
    .addSubcommand(sub =>
      sub.setName('sell')
        .setDescription('Poner un artículo a la venta')
        .addStringOption(o => o.setName('nombre').setDescription('Nombre del artículo').setRequired(true).setMaxLength(80))
        .addNumberOption(o => o.setName('precio').setDescription('Precio').setRequired(true).setMinValue(0.01))
        .addStringOption(o => o.setName('descripcion').setDescription('Descripción').setRequired(false).setMaxLength(300))
        .addIntegerOption(o => o.setName('cantidad').setDescription('Stock disponible (-1 = ilimitado)').setRequired(false).setMinValue(-1))
    )
    .addSubcommand(sub =>
      sub.setName('buy')
        .setDescription('Comprar un artículo')
        .addIntegerOption(o => o.setName('id').setDescription('ID del artículo').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Retirar un artículo de la tienda')
        .addIntegerOption(o => o.setName('id').setDescription('ID del artículo').setRequired(true))
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    // ── LIST ──────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const listings = db.getListings(guildId);
      if (!listings.length) {
        return interaction.editReply({ embeds: [info('🛒 La tienda está vacía. ¡Usa `/shop sell` para poner algo a la venta!')] });
      }

      const embed = new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle('🛒 Tienda del servidor')
        .setDescription(
          listings.map(l => [
            `**#${l.id} — ${l.item_name}** · ${fmt(l.price)}`,
            l.description ? `> ${l.description}` : null,
            `> 👤 Vendedor: <@${l.seller_id}> · 📦 Stock: ${l.quantity === -1 ? '∞' : l.quantity}`,
          ].filter(Boolean).join('\n')).join('\n\n')
        )
        .setFooter({ text: 'Usa /shop buy <id> para comprar · /shop sell para vender' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── SELL ─────────────────────────────────────────────────────────────────
    if (sub === 'sell') {
      const nombre = interaction.options.getString('nombre');
      const precio = interaction.options.getNumber('precio');
      const descripcion = interaction.options.getString('descripcion') ?? null;
      const cantidad = interaction.options.getInteger('cantidad') ?? -1;

      const result = db.createListing(guildId, interaction.user.id, nombre, descripcion, precio, cantidad);
      syncShopListing(interaction.user.id, nombre, descripcion ?? '', precio, cantidad);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('🏷️ Artículo publicado en la tienda')
            .addFields(
              { name: 'ID', value: `#${result.lastInsertRowid}`, inline: true },
              { name: 'Artículo', value: nombre, inline: true },
              { name: 'Precio', value: fmt(precio), inline: true },
              { name: 'Stock', value: cantidad === -1 ? 'Ilimitado' : String(cantidad), inline: true },
              ...(descripcion ? [{ name: 'Descripción', value: descripcion }] : []),
            )
            .setDescription('Para retirarlo usa `/shop remove <id>`.')
            .setTimestamp(),
        ],
      });
    }

    // ── BUY ──────────────────────────────────────────────────────────────────
    if (sub === 'buy') {
      const id = interaction.options.getInteger('id');
      const listing = db.getListing(id);

      if (!listing || listing.guild_id !== guildId) return interaction.editReply({ embeds: [err(`No existe el artículo **#${id}**.`)] });
      if (listing.quantity === 0) return interaction.editReply({ embeds: [err('Este artículo está agotado.')] });
      if (listing.seller_id === interaction.user.id) return interaction.editReply({ embeds: [err('No puedes comprarte tu propio artículo.')] });

      const buyerAccount = db.getBalance(guildId, interaction.user.id);
      if (buyerAccount.balance < listing.price) {
        return interaction.editReply({ embeds: [err(`Saldo insuficiente. Necesitas ${fmt(listing.price)} y tienes ${fmt(buyerAccount.balance)}.`)] });
      }

      const confirmEmbed = new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle('🛒 Confirmar compra')
        .addFields(
          { name: '🏷️ Artículo', value: `#${id} — ${listing.item_name}`, inline: true },
          { name: '💰 Precio', value: fmt(listing.price), inline: true },
          { name: '👤 Vendedor', value: `<@${listing.seller_id}>`, inline: true },
          { name: '💵 Saldo tras compra', value: fmt(buyerAccount.balance - listing.price), inline: true },
          ...(listing.description ? [{ name: '📄 Descripción', value: listing.description }] : []),
        )
        .setFooter({ text: 'Expira en 30 segundos' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('shop_buy_confirm').setLabel('✅ Comprar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('shop_buy_cancel').setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger),
      );

      const reply = await interaction.editReply({ embeds: [confirmEmbed], components: [row] });

      const collector = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time: 30_000, max: 1,
      });

      collector.on('collect', async i => {
        if (i.customId === 'shop_buy_cancel') {
          return i.update({ embeds: [new EmbedBuilder().setColor(Colors.Orange).setDescription('❌ Compra cancelada.')], components: [] });
        }

        const freshListing = db.getListing(id);
        if (!freshListing || freshListing.quantity === 0) {
          return i.update({ embeds: [err('Este artículo se agotó mientras confirmabas.')], components: [] });
        }
        const freshBuyer = db.getBalance(guildId, interaction.user.id);
        if (freshBuyer.balance < freshListing.price) {
          return i.update({ embeds: [err('Ya no tienes suficiente saldo.')], components: [] });
        }

        db.removeBalance(guildId, interaction.user.id, freshListing.price, `Compra tienda: ${freshListing.item_name}`, 'purchase');
        db.addBalance(guildId, freshListing.seller_id, freshListing.price, `Venta tienda: ${freshListing.item_name}`, 'sale');
        db.decrementListing(id);

        const newBuyerBalance = db.getBalance(guildId, interaction.user.id).balance;
        const newSellerBalance = db.getBalance(guildId, freshListing.seller_id).balance;
        const timestamp = new Date().toLocaleString('es-ES');

        // Ticket al comprador por DM
        try {
          await interaction.user.send({ embeds: [ticketCompra(interaction.guild.name, freshListing, newBuyerBalance, timestamp)] });
        } catch (_) {}

        // Ticket al vendedor por DM
        try {
          const seller = await interaction.client.users.fetch(freshListing.seller_id);
          await seller.send({ embeds: [ticketVenta(interaction.guild.name, freshListing, interaction.user, newSellerBalance, timestamp)] });
        } catch (_) {}

        return i.update({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle('✅ ¡Compra realizada!')
              .addFields(
                { name: 'Artículo', value: freshListing.item_name, inline: true },
                { name: 'Pagado', value: fmt(freshListing.price), inline: true },
                { name: 'Nuevo saldo', value: fmt(newBuyerBalance), inline: true },
              )
              .setDescription('📩 Se ha enviado un ticket de compra a tu DM.')
              .setTimestamp(),
          ],
          components: [],
        });
      });

      collector.on('end', collected => {
        if (!collected.size) {
          interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setDescription('⏱️ Tiempo agotado. Compra cancelada.')], components: [] }).catch(() => {});
        }
      });

      return;
    }

    // ── REMOVE ───────────────────────────────────────────────────────────────
    if (sub === 'remove') {
      const id = interaction.options.getInteger('id');
      const listing = db.getListing(id);

      if (!listing || listing.guild_id !== guildId) return interaction.editReply({ embeds: [err(`No existe el artículo **#${id}**.`)] });
      if (listing.seller_id !== interaction.user.id && !isAdmin) {
        const customPerm = db.hasCustomPermission(guildId, 'shop.remove.any', interaction.member);
        if (!customPerm) {
          return interaction.editReply({ embeds: [err('Solo puedes retirar artículos que tú hayas publicado.')] });
        }
      }

      // Confirmation
      const confirmEmbed = new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle('🗑️ Confirmar retirada')
        .setDescription(`¿Seguro que quieres retirar **${listing.item_name}** de la tienda?`)
        .addFields(
          { name: 'Artículo', value: listing.item_name, inline: true },
          { name: 'Precio', value: fmt(listing.price), inline: true },
        )
        .setFooter({ text: 'Expira en 30 segundos' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('shop_rem_confirm').setLabel('🗑️ Retirar').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('shop_rem_cancel').setLabel('❌ Cancelar').setStyle(ButtonStyle.Secondary),
      );

      const reply = await interaction.editReply({ embeds: [confirmEmbed], components: [row] });

      const collector = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time: 30_000, max: 1,
      });

      collector.on('collect', async i => {
        if (i.customId === 'shop_rem_cancel') {
          return i.update({ embeds: [new EmbedBuilder().setColor(Colors.Blue).setDescription('↩️ Cancelado. El artículo sigue en la tienda.')], components: [] });
        }
        db.removeListing(id);
        deactivateShopListing(interaction.user.id, listing.item_name);
        return i.update({
          embeds: [new EmbedBuilder().setColor(Colors.Orange).setDescription(`🗑️ Artículo **${listing.item_name}** retirado de la tienda.`)],
          components: [],
        });
      });

      collector.on('end', collected => {
        if (!collected.size) {
          interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setDescription('⏱️ Tiempo agotado.')], components: [] }).catch(() => {});
        }
      });
    }
  },
};

// ── Ticket helpers ────────────────────────────────────────────────────────────

function ticketCompra(guildName, listing, newBalance, timestamp) {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('🧾 Ticket de compra')
    .setDescription('```\n════════════════════════\n   TICKET DE COMPRA\n════════════════════════\n```')
    .addFields(
      { name: '🏰 Tienda', value: guildName, inline: true },
      { name: '📅 Fecha', value: timestamp, inline: true },
      { name: '​', value: '​', inline: false },
      { name: '🛒 Artículo', value: listing.item_name, inline: true },
      { name: '💰 Precio', value: fmt(listing.price), inline: true },
      { name: '👤 Vendedor', value: `<@${listing.seller_id}>`, inline: true },
      { name: '💵 Saldo restante', value: fmt(newBalance), inline: true },
    )
    .setFooter({ text: '¡Gracias por tu compra!' })
    .setTimestamp();
}

function ticketVenta(guildName, listing, buyer, newBalance, timestamp) {
  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('🏷️ Ticket de venta')
    .setDescription('```\n════════════════════════\n     TICKET DE VENTA\n════════════════════════\n```')
    .addFields(
      { name: '🏰 Tienda', value: guildName, inline: true },
      { name: '📅 Fecha', value: timestamp, inline: true },
      { name: '​', value: '​', inline: false },
      { name: '🛒 Artículo vendido', value: listing.item_name, inline: true },
      { name: '💰 Ingreso', value: fmt(listing.price), inline: true },
      { name: '👤 Comprador', value: buyer.tag, inline: true },
      { name: '💵 Nuevo saldo', value: fmt(newBalance), inline: true },
    )
    .setFooter({ text: '¡Venta completada!' })
    .setTimestamp();
}

function err(msg) { return new EmbedBuilder().setColor(Colors.Red).setTitle('❌ Error').setDescription(msg); }
function info(msg) { return new EmbedBuilder().setColor(Colors.Blue).setDescription(msg); }
