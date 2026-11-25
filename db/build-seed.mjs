/**
 * db/build-seed.mjs
 * ---------------------------------------------------------------------------
 * Genera los datos de prueba de la web (los mismos que usa el modo local,
 * buildSeedData() de js/data.js) listos para cargarlos en Neon.
 *
 *   node db/build-seed.mjs > db/seed.sql      SQL para Neon Console › SQL Editor
 *   node db/build-seed.mjs --json             Solo los datos (JSON)
 *
 * Las fechas son relativas al momento de generarlo (p. ej. «publicado hace 2
 * días»), así que conviene regenerarlo justo antes de cargarlo.
 *
 * El SQL llama a lonja_internal.load_seed() (definida en db/schema.sql):
 *  - necesita que existan las 5 cuentas de prueba en Neon Auth
 *    (node db/create-demo-accounts.mjs);
 *  - BORRA todos los datos de la marketplace (perfiles, anuncios, pedidos,
 *    favoritos, mensajes, valoraciones y denuncias) y carga los de prueba.
 *    No toca las cuentas de Neon Auth.
 */
import { buildSeedData, DEMO_ACCOUNTS } from '../js/data.js';

const seed = buildSeedData();
const legacyIds = new Set(DEMO_ACCOUNTS.map((account) => account.legacyId));
const userRef = (id) => {
  if (!legacyIds.has(id)) throw new Error(`Usuario de prueba desconocido: ${id}`);
  return id;
};

const profiles = seed.users.map((user) => ({
  legacy: userRef(user.id),
  username: user.username,
  display_name: user.displayName,
  first_name: user.firstName,
  last_name: user.lastName,
  avatar: user.avatar,
  bio: user.bio,
  public_location: user.publicLocation,
  preferences: user.preferences,
  created_at: user.createdAt,
  email: user.email,
  phone: user.phone,
  birth_date: user.birthDate,
  country: user.country,
  city: user.city,
  address: user.address,
}));

const listings = seed.listings.map((listing) => ({
  id: listing.id,
  seller: userRef(listing.sellerId),
  title: listing.title,
  description: listing.description,
  category: listing.category,
  subcategory: listing.subcategory,
  operation_type: listing.operationType,
  price: listing.price,
  currency: listing.currency,
  rental: listing.rental,
  condition: listing.condition,
  brand: listing.brand,
  model: listing.model,
  availability: listing.availability,
  delivery_notes: listing.deliveryNotes,
  attributes: listing.attributes,
  custom_attributes: listing.customAttributes,
  // Referencia corta en lugar de la ilustración SVG completa (ver resolveImageSrc en data.js).
  images: listing.images.map(({ id, ref, alt }) => ({ id, src: ref, alt })),
  location: listing.location,
  delivery: listing.delivery,
  status: listing.status,
  featured: listing.featured,
  views: listing.views,
  price_history: listing.priceHistory,
  created_at: listing.createdAt,
  updated_at: listing.updatedAt,
}));

const orders = seed.orders.map((order) => ({
  id: order.id,
  listing_id: order.listingId,
  buyer: userRef(order.buyerId),
  seller: userRef(order.sellerId),
  operation_type: order.operationType,
  amount: order.amount,
  currency: order.currency,
  units: order.units,
  start_date: order.startDate,
  end_date: order.endDate,
  status: order.status,
  delivery: order.delivery,
  status_history: order.statusHistory,
  created_at: order.createdAt,
  updated_at: order.updatedAt,
}));

const favorites = seed.favorites.map((favorite) => ({
  id: favorite.id, owner: userRef(favorite.userId), listing_id: favorite.listingId, created_at: favorite.createdAt,
}));

const messages = seed.messages.map((message) => {
  const listing = seed.listings.find((candidate) => candidate.id === message.listingId);
  const buyer = message.senderId === listing.sellerId ? message.receiverId : message.senderId;
  return {
    id: message.id, listing_id: message.listingId, buyer: userRef(buyer), sender: userRef(message.senderId),
    receiver: userRef(message.receiverId), content: message.content, created_at: message.createdAt, read: message.read,
  };
});

const reviews = seed.reviews.map((review) => ({
  id: review.id, order_id: review.orderId, listing_id: review.listingId, reviewer: userRef(review.reviewerId),
  reviewee: userRef(review.revieweeId), rating: review.rating, comment: review.comment, created_at: review.createdAt,
}));

const payload = {
  accounts: DEMO_ACCOUNTS.map(({ legacyId, email }) => ({ legacyId, email })),
  profiles, listings, orders, favorites, messages, reviews,
};

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(payload));
} else {
  const text = JSON.stringify(payload);
  if (text.includes('$seed$')) throw new Error('Los datos contienen el delimitador $seed$');
  process.stdout.write(`-- =============================================================================
-- Lonja · Datos de prueba para Neon
-- Generado por db/build-seed.mjs el ${new Date().toISOString()}. No editar a mano.
-- Ejecútalo en Neon Console › SQL Editor (rama production, base de datos neondb).
-- ⚠️ BORRA todos los datos de la marketplace y carga los de prueba.
--    No toca las cuentas de Neon Auth (neon_auth."user").
-- =============================================================================
select lonja_internal.load_seed($seed$${text}$seed$::jsonb);
`);
}
