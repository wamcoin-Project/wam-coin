package org.vslabs.wam_miner;

import android.app.NativeActivity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.vslabs.model.MinerConfigModel;

public class MinerNativeActivity extends NativeActivity {

    static {
        System.loadLibrary("wam-miner");
    }

    private native void destroyNativeMinerEngine();

    private TextView logTextView;
    private ScrollView scrollView;
    private LinearLayout mainLayout;
    private boolean isReceiverRegistered = false;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    private final BroadcastReceiver nativeLogReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null) {
                String action = intent.getAction();

                if (MinerNativeService.ACTION_NATIVE_LOG_BROADCAST.equals(action)) {
                    String logLine = intent.getStringExtra("LOG_LINE"); //
                    if (logLine != null) {
                        appendConsoleLog(logLine); //
                    }
                } else if (MinerNativeService.ACTION_STOP_NATIVE.equals(action)) {
                    Log.i("WAM_APK_UI", "Quit intent intercepted. Finishing Native Activity canvas.");
                    // Safely close this activity so it drops back to ConfigActivity
                    finish();
                }
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);

        // =======================================================================
        // FIX PASS A: Register Broadcast Bus immediately before layouts instantiate
        // =======================================================================
        registerLogReceiverSafely();

        Intent intent = getIntent();
        if (intent != null && intent.hasExtra("CONFIG")) {
            MinerConfigModel config = (MinerConfigModel) intent.getSerializableExtra("CONFIG");
        }
    }

    @Override
    protected void onStart() {
        super.onStart();

        if (mainLayout == null) {
            mainLayout = new LinearLayout(this);
            mainLayout.setOrientation(LinearLayout.VERTICAL);
            mainLayout.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            LinearLayout topSpacer = new LinearLayout(this);
            LinearLayout.LayoutParams topParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0.25f);
            topSpacer.setLayoutParams(topParams);
            mainLayout.addView(topSpacer);

            scrollView = new ScrollView(this);
            LinearLayout.LayoutParams bottomParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0.75f);
            scrollView.setLayoutParams(bottomParams);
            scrollView.setBackgroundColor(0xFF121212);

            logTextView = new TextView(this);
            logTextView.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            logTextView.setPadding(35, 35, 35, 35);
            logTextView.setTextSize(13);
            logTextView.setTextColor(0xFF00FF00);
            logTextView.setTypeface(android.graphics.Typeface.MONOSPACE);

            scrollView.addView(logTextView);
            mainLayout.addView(scrollView);

            addContentView(mainLayout, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            logTextView.setText("--- WAM NATIVE ENGINE TERMINAL OVERLAY ACTIVE ---\n");
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // =======================================================================
        // FIX PASS B: Force re-registration loop mapping on focus baseline change
        // =======================================================================
        registerLogReceiverSafely();
    }

    private synchronized void registerLogReceiverSafely() {
        if (!isReceiverRegistered) {
            IntentFilter filter = new IntentFilter();
            filter.addAction(MinerNativeService.ACTION_NATIVE_LOG_BROADCAST); // Catch logs
            filter.addAction(MinerNativeService.ACTION_STOP_NATIVE);         // Catch quit click

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(nativeLogReceiver, filter, Context.RECEIVER_EXPORTED); //
            } else {
                registerReceiver(nativeLogReceiver, filter); //
            }

            isReceiverRegistered = true;
            Log.i("WAM_APK_UI", "Broadcast log monitoring subsystem mapped universally."); //
        }
    }

    private synchronized void unregisterLogReceiverSafely() {
        if (isReceiverRegistered) {
            try {
                unregisterReceiver(nativeLogReceiver);
            } catch (Exception e) {
                Log.w("WAM_APK_UI", "Receiver clean warning: already unmapped.");
            }
            isReceiverRegistered = false;
        }
    }

    @Override
    protected void onPause() {
        // Leave receiver attached if background processing needs continuous trace,
        // otherwise unregister here to follow standard rules:
        super.onPause();
    }

    @Override
    protected void onStop() {
        super.onStop();
        unregisterLogReceiverSafely();
    }

    public void appendConsoleLog(final String text) {
        uiHandler.post(() -> {
            if (logTextView != null) {
                // Fixed: Appends the combined multi-line block directly as it arrives
                logTextView.append(text);
                scrollView.post(() -> scrollView.fullScroll(ScrollView.FOCUS_DOWN));
            }
        });
    }

    @Override
    protected void onDestroy() {
        unregisterLogReceiverSafely();
        destroyNativeMinerEngine();
        Intent stopServiceIntent = new Intent(this, MinerNativeService.class);
        stopServiceIntent.setAction(MinerNativeService.ACTION_STOP_NATIVE);
        startService(stopServiceIntent);
        super.onDestroy();
    }
}
