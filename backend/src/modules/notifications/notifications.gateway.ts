// Tầng API realtime (EN-03 bước 3): namespace Socket.IO /notifications, giống controller nhưng cho kết nối socket.
// Kiểm Origin + access token lúc handshake, kiểm lại phiên trước mỗi emit và mỗi ack; luật nằm ở NotificationsService.
import { ConfigService } from '@nestjs/config';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
  SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AuthPrincipal } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';
import { AckResult, DispatchMessage } from './notifications.types';

// Dữ liệu server tự gắn vào socket sau handshake; client không sửa được.
interface SocketData { accountId: string; accessToken: string }

@WebSocketGateway({ namespace: '/notifications' })
export class NotificationsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  // EN-03-F06: gateway tự quản lý các socket đã xác thực theo account; không dùng room do client xin join.
  private readonly socketsByAccount = new Map<string, Set<Socket>>();

  constructor(private readonly notifications: NotificationsService, private readonly config: ConfigService) {}

  // EN-03-TC09: middleware handshake chạy trước khi kết nối được chấp nhận; lỗi thì client nhận connect_error.
  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      this.authenticateHandshake(socket).then(() => next(), () => next(new Error('UNAUTHORIZED')));
    });
  }

  private async authenticateHandshake(socket: Socket): Promise<void> {
    // Origin phải đúng FRONTEND_ORIGIN như HTTP.
    if (socket.handshake.headers.origin !== this.config.getOrThrow<string>('frontendOrigin')) throw new Error('INVALID_ORIGIN');
    // Chỉ đọc token từ auth.accessToken, không đọc query URL. accountId client tự khai bị bỏ qua (EN-03-TC11).
    const accessToken: unknown = socket.handshake.auth?.accessToken;
    const principal = await this.notifications.authenticateRecipient(accessToken);
    const data: SocketData = { accountId: principal.id, accessToken: accessToken as string };
    socket.data = data;
  }

  handleConnection(socket: Socket): void {
    const { accountId } = socket.data as SocketData;
    const sockets = this.socketsByAccount.get(accountId) ?? new Set<Socket>();
    sockets.add(socket);
    this.socketsByAccount.set(accountId, sockets);
  }

  handleDisconnect(socket: Socket): void {
    const accountId = (socket.data as SocketData | undefined)?.accountId;
    if (!accountId) return;
    const sockets = this.socketsByAccount.get(accountId);
    sockets?.delete(socket);
    if (sockets?.size === 0) this.socketsByAccount.delete(accountId);
  }

  // EN-03-TC11: chỉ gửi tới socket của đúng recipient; mỗi socket được kiểm lại phiên ngay trước emit (EN-03-TC10, TC12).
  // Người nhận không có socket nào (offline) thì không gửi gì và vẫn là thành công (EN-03-TC07).
  async sendToRecipients(message: DispatchMessage): Promise<void> {
    for (const accountId of message.recipientAccountIds) {
      const sockets = [...(this.socketsByAccount.get(accountId) ?? [])];
      for (const socket of sockets) {
        const principal = await this.recheck(socket);
        if (principal) socket.emit('notification.created', message.notification);
      }
    }
  }

  // EN-03-TC13: client ack {notificationId}; giá trị trả về là phản hồi cho callback ack của Socket.IO.
  // Guard HTTP không chạy cho socket, nên gateway tự kiểm lại phiên ngay dưới đây.
  @SubscribeMessage('notification.ack')
  async handleAck(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<AckResult> {
    const principal = await this.recheck(socket);
    if (!principal) return { ok: false, error: { code: 'UNAUTHORIZED' } };
    const notificationId = typeof body === 'object' && body !== null ? (body as { notificationId?: unknown }).notificationId : undefined;
    return this.notifications.acknowledge(principal.id, notificationId);
  }

  // EN-03-F06: kiểm lại token/phiên/account/role của socket. Không còn quyền, token hết hạn hoặc DB lỗi
  // thì ngắt socket và không gửi nội dung (không fail-open); client refresh HTTP rồi kết nối lại.
  private async recheck(socket: Socket): Promise<AuthPrincipal | null> {
    const data = socket.data as SocketData;
    try {
      const principal = await this.notifications.authenticateRecipient(data.accessToken);
      if (principal.id === data.accountId) return principal;
    } catch {
      // Gộp mọi lỗi vào nhánh ngắt kết nối bên dưới.
    }
    socket.disconnect(true);
    return null;
  }
}
