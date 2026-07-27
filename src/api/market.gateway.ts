/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  Logger,
  Injectable,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { Trade } from '../domain/types/order.types';
import { AuthService } from '../auth/auth.service';
import { MetricsService } from '../metrics/metrics.service';

@WebSocketGateway({ cors: true })
@Injectable()
export class MarketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketGateway.name);

  constructor(
    @Inject(forwardRef(() => AuthService))
    private readonly authService?: AuthService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {}

  async handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.metricsService?.incrementWsConnections();
    await client.join('market-data');

    // Attempt token validation for user-scoped socket room
    const token =
      (client.handshake.auth?.token as string) ||
      (client.handshake.headers?.authorization?.replace(
        'Bearer ',
        '',
      ) as string);

    if (token && this.authService) {
      const payload = await this.authService.validateToken(token);
      if (payload) {
        client.data.user = payload;
        await client.join(`user:${payload.sub}`);
        this.logger.log(
          `Authenticated socket ${client.id} for user ${payload.sub}`,
        );
      }
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.metricsService?.decrementWsConnections();
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

  /**
   * Sends user-specific order execution notifications to the user's socket room.
   */
  notifyUserOrderFilled(userId: string, data: Record<string, unknown>) {
    if (!this.server) return;
    this.server.to(`user:${userId}`).emit('order_filled', data);
  }
}
