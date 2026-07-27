import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { Trade } from '../domain/types/order.types';

@WebSocketGateway({ cors: true })
export class MarketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketGateway.name);

  async handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    await client.join('market-data');
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Broadcasts executed trades to all listening frontend clients.
   */
  broadcastTrades(trades: Trade[]) {
    if (trades.length === 0 || !this.server) return;

    // Broadcast to the 'market-data' room
    this.server.to('market-data').emit('trades_executed', trades);
  }

  /**
   * Broadcasts a simplified view of the top of the book.
   */
  broadcastBookUpdate(
    instrument: string,
    bestBid: number | null,
    bestAsk: number | null,
  ) {
    if (!this.server) return;

    this.server.to('market-data').emit('book_updated', {
      instrument,
      bestBid,
      bestAsk,
    });
  }

  /**
   * Broadcasts aggregated L2 order book depth updates over WebSockets.
   */
  broadcastDepthUpdate(
    instrument: string,
    depth: {
      bids: Array<{ price: number; quantity: number }>;
      asks: Array<{ price: number; quantity: number }>;
    },
  ) {
    if (!this.server) return;

    this.server.to('market-data').emit('depth_updated', {
      instrument,
      ...depth,
    });
  }
}
