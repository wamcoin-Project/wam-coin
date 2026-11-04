package org.vslabs.wam_miner;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.vslabs.model.MinerConfigModel;

import java.util.Timer;
import java.util.TimerTask;

public class MinerNativeService extends Service {
    private static final String TAG = "WAM_APK_SERVICE";
    private static final String CHANNEL_ID = "MinerNativeServiceChannel";
    private static final int NOTIFICATION_ID = 9554;

    public static final String ACTION_START_NATIVE = "org.vslabs.wam_miner.START_NATIVE";
    public static final String ACTION_STOP_NATIVE = "org.vslabs.wam_miner.STOP_NATIVE";
    public static final String ACTION_NATIVE_LOG_BROADCAST = "org.vslabs.wam_miner.NATIVE_LOG_BROADCAST";

    private Timer statReportingTimer;
    private long lastHashCount = 0;

    private final Object logBufferLock = new Object();
    private final StringBuilder logBuffer = new StringBuilder();

    static {
        System.loadLibrary("wam-miner");
    }

    private native boolean initializeNativeEngine(int threads);

    private native void startPoolMining(String host, int port, String user, String pass);

    private native void terminateNativeEngine();

    private native long getNativeTotalHashes();

    private native long getNativeAcceptedShares();

    private native long getNativeRejectedShares();

    @androidx.annotation.Keep
    public void dispatchNativeLogToUI(String rawMessage) {
        synchronized (logBufferLock) {
            logBuffer.append(rawMessage).append("\n");
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();

        if (action.equalsIgnoreCase(ACTION_START_NATIVE)) {
            MinerConfigModel config = (MinerConfigModel) intent.getSerializableExtra("CONFIG");
            if (config == null) {
                stopSelf();
                return START_NOT_STICKY;
            }

            Notification notification = buildForegroundNotification(config.stratum, config.port);
            startForeground(NOTIFICATION_ID, notification);

            executeNativeMinerPipeline(config);
        } else if (action.equalsIgnoreCase(ACTION_STOP_NATIVE)) {
            Log.i(TAG, "Termination request processed. Broadcasting system signals down to windows.");

            // 1. Broadcast the quit message so LogsActivity drops closed automatically if running
            Intent syncQuitIntent = new Intent(ACTION_STOP_NATIVE);
            sendBroadcast(syncQuitIntent);

            // 2. Tear down the persistent notification canvas
            stopForeground(true);
            stopSelf();
        }

        return START_NOT_STICKY;
    }

    private void executeNativeMinerPipeline(MinerConfigModel config) {
        new Thread(() -> {
            int coresToUse = (config.cores > 0) ? config.cores : 1;
            if (initializeNativeEngine(coresToUse)) {
                // config.address already contains adress.worker_name (if provided)
                startPoolMining(config.stratum, config.port, config.address, config.name);
                startUIReportingLoop();
            } else {
                stopSelf();
            }
        }).start();
    }

    private void startUIReportingLoop() {
        if (statReportingTimer != null) statReportingTimer.cancel();

        statReportingTimer = new Timer();
        statReportingTimer.schedule(new TimerTask() {
            @Override
            public void run() {
                long totalHashes = getNativeTotalHashes();
                long accepted = getNativeAcceptedShares();
                long rejected = getNativeRejectedShares();

                long hashesInWindow = totalHashes - lastHashCount;
                lastHashCount = totalHashes;
                double hashrate = hashesInWindow / 10.0;

                String statsLine = String.format("[Native Engine] %.2f H/s | Shares Acc: %d | Rej: %d | Total Hashes: %d",
                        hashrate, accepted, rejected, totalHashes);

                String combinedPayload;
                synchronized (logBufferLock) {
                    logBuffer.append(statsLine).append("\n");
                    combinedPayload = logBuffer.toString();
                    logBuffer.setLength(0);
                }

                Intent intent = new Intent(ACTION_NATIVE_LOG_BROADCAST);
                intent.putExtra("LOG_LINE", combinedPayload);
                sendBroadcast(intent);
            }
        }, 10000, 10000);
    }

    private Notification buildForegroundNotification(String stratum, int port) {
        Intent notificationIntent = new Intent(this, LogsActivity.class);
        notificationIntent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;

        PendingIntent contentPendingIntent = PendingIntent.getActivity(this, 0, notificationIntent, pendingIntentFlags);

        // Map notification quit click directly into the system broadcast target engine
        Intent broadcastQuitIntent = new Intent(ACTION_STOP_NATIVE);
        PendingIntent quitPendingIntent = PendingIntent.getBroadcast(this, 1, broadcastQuitIntent, pendingIntentFlags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("WAM Native Core Active")
                .setContentText("Connected: " + stratum + ":" + port)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(contentPendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Quit Miner", quitPendingIntent)
                .build();
    }

    private void createNotificationChannel() {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID, "WAM Native Miner Processing Channel", NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(serviceChannel);
    }

    @Override
    public void onDestroy() {
        if (statReportingTimer != null) {
            statReportingTimer.cancel();
            statReportingTimer = null;
        }

        synchronized (logBufferLock) {
            logBuffer.setLength(0);
        }

        try {
            terminateNativeEngine();
        } catch (Exception e) {
            Log.e(TAG, "Error cleaning native execution context: " + e.getMessage());
        }

        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
