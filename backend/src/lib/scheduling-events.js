/**
 * Scheduling event bus — notification foundation (Phase C).
 *
 * In-process pub/sub so scheduling side effects (email today, SMS/WhatsApp/
 * Telegram and the centralized notification engine in later phases) can
 * attach without redesigning the appointment APIs. The bookings route emits
 * events fire-and-forget after each successful write; handlers must never
 * throw into the request path (they are wrapped with a catch in the route).
 *
 * Documented events (payload: { bookingId, reference, businessId,
 * actorId, actorName, details, warnings }):
 *   booking.created       appointment created
 *   booking.updated       fields changed (no reschedule)
 *   booking.rescheduled   scheduledAt changed
 *   booking.assigned      technician assigned / unassigned
 *   booking.cancelled     status set to CANCELLED
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);

function emit(event, payload) {
  try {
    bus.emit(event, payload);
  } catch (_) {
    // Notification side effects must never break the appointment request.
  }
}

function on(event, handler) {
  bus.on(event, handler);
  return () => bus.off(event, handler);
}

module.exports = { bus, emit, on };
