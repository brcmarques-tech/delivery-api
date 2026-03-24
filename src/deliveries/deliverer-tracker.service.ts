import { Injectable, Logger } from '@nestjs/common';

export interface DelivererLocation {
  userId: string;
  socketId: string;
  latitude: number;
  longitude: number;
  vehicleType: string;
  updatedAt: Date;
  distance?: number;
}

@Injectable()
export class DelivererTrackerService {
  private readonly logger = new Logger(DelivererTrackerService.name);
  // Map of userId -> location data
  private onlineDeliverers = new Map<string, DelivererLocation>();

  setOnline(userId: string, socketId: string, latitude: number, longitude: number, vehicleType?: string) {
    const wasOnline = this.onlineDeliverers.has(userId);
    this.onlineDeliverers.set(userId, {
      userId,
      socketId,
      latitude,
      longitude,
      vehicleType: vehicleType || 'MOTO',
      updatedAt: new Date(),
    });
    if (!wasOnline) { /* first connect */ }
  }

  updateLocation(userId: string, latitude: number, longitude: number) {
    const existing = this.onlineDeliverers.get(userId);
    if (existing) {
      existing.latitude = latitude;
      existing.longitude = longitude;
      existing.updatedAt = new Date();
    }
  }

  setOffline(userId: string) {
    this.onlineDeliverers.delete(userId);
  }

  removeBySocketId(socketId: string) {
    for (const [userId, data] of this.onlineDeliverers) {
      if (data.socketId === socketId) {
        this.onlineDeliverers.delete(userId);
        return userId;
      }
    }
    return null;
  }

  getSocketId(userId: string): string | null {
    return this.onlineDeliverers.get(userId)?.socketId || null;
  }

  isOnline(userId: string): boolean {
    return this.onlineDeliverers.has(userId);
  }

  getDelivererLocation(userId: string): DelivererLocation | null {
    return this.onlineDeliverers.get(userId) || null;
  }

  getOnlineCount(): number {
    return this.onlineDeliverers.size;
  }

  /**
   * Returns online deliverers sorted by distance from a point (nearest first).
   * Excludes deliverers in the `exclude` set.
   */
  getNearestDeliverers(
    storeLat: number,
    storeLng: number,
    exclude: Set<string> = new Set(),
  ): DelivererLocation[] {
    const deliverers: DelivererLocation[] = [];

    for (const [userId, data] of this.onlineDeliverers) {
      if (exclude.has(userId)) continue;

      // Haversine distance in km
      const R = 6371;
      const dLat = (data.latitude - storeLat) * Math.PI / 180;
      const dLng = (data.longitude - storeLng) * Math.PI / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(storeLat * Math.PI / 180) *
          Math.cos(data.latitude * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;

      deliverers.push({ ...data, distance });
    }

    deliverers.sort((a, b) => (a.distance || 0) - (b.distance || 0));
    return deliverers;
  }

  getNearestDelivererInfo(storeLat: number, storeLng: number): { distanceKm: number; vehicleType: string } | null {
    const nearest = this.getNearestDeliverers(storeLat, storeLng);
    if (nearest.length === 0) return null;
    return { distanceKm: nearest[0].distance || 0, vehicleType: nearest[0].vehicleType };
  }
}
