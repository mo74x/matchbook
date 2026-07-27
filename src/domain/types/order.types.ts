export type OrderSide = 'BID' | 'ASK';
export type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';

export interface Order {
  id: string;
  instrument: string;
  side: OrderSide;
  type?: OrderType;
  price: number;
  initialQuantity: number;
  remainingQuantity: number;
  timestamp: number;
}

export interface Trade {
  id: string;
  instrument: string;
  makerOrderId: string;
  takerOrderId: string;
  price: number;
  quantity: number;
  executedAt: number;
}
