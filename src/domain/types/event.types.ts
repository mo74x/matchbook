import { EventType } from '../../../generated/prisma/enums';
import { OrderSide } from './order.types';

export interface BaseEventPayload {
  price: number;
  side: OrderSide;
}

// Fired when a new order enters the system
export interface OrderPlacedPayload extends BaseEventPayload {
  quantity: number;
}

// Fired when an order matches against a resting order
export interface OrderMatchedPayload extends BaseEventPayload {
  counterpartyOrderId: string;
  matchedQuantity: number;
  matchedPrice: number;
  tradeId: string;
}

// Fired when a user cancels an order, or it's cancelled by the system
export interface OrderCancelledPayload extends BaseEventPayload {
  remainingQuantity: number;
}

// Fired when an order is partially filled, but still has remaining quantity resting in the book
export interface OrderPartiallyFilledPayload extends BaseEventPayload {
  filledQuantity: number;
  remainingQuantity: number;
}

// Discriminated Union mapping the Prisma Enum to the correct Payload interface
export type OrderEventPayload =
  | { type: typeof EventType.ORDER_PLACED; data: OrderPlacedPayload }
  | { type: typeof EventType.ORDER_MATCHED; data: OrderMatchedPayload }
  | { type: typeof EventType.ORDER_CANCELLED; data: OrderCancelledPayload }
  | {
      type: typeof EventType.ORDER_PARTIALLY_FILLED;
      data: OrderPartiallyFilledPayload;
    };

// The final shape of an event after it is fetched from the DB
export interface DomainOrderEvent {
  sequenceId: bigint;
  instrument: string;
  eventType: EventType;
  orderId: string;
  payload: OrderEventPayload['data'];
  createdAt: Date;
}
