
function listenToMyPermissions() {
  stopListener(stopPermissionListener);
  stopPermissionListener = null;

  if (isHost) {
    micAllowed = true;
    cameraAllowed = true;
    updateMicButton();
    updateCameraButton();
    return;
  }

  stopPermissionListener = onValue(
    ref(db, `participantControls/${showId}/${currentUser.uid}`),

    async snapshot => {
      // First-time singers get camera ON and microphone OFF.
      const controls = snapshot.val() || {};

      cameraAllowed =
        typeof controls.cameraAllowed === "boolean"
          ? controls.cameraAllowed
          : true;

      micAllowed =
        typeof controls.microphoneAllowed === "boolean"
          ? controls.microphoneAllowed
          : false;

      $("localPermissionMessage").textContent =
        "Host permissions: Camera " +
        (cameraAllowed ? "ON" : "OFF") +
        " • Microphone " +
        (micAllowed ? "ON" : "OFF");

      try {
        if (cameraAllowed) {
          await startCamera();
        } else {
          await stopCamera();
        }

        if (micAllowed) {
          await startMicrophone();
        } else {
          await stopMicrophone();
        }
      } catch (error) {
        console.error("Permission application:", error);
        setStatus(
          "Could not apply host permissions: " + error.message,
          true
        );
      }

      updateMicButton();
      updateCameraButton();
    },

    error => {
      console.error("Permission listener:", error);
      setStatus("Could not read your host permissions.", true);
    }
  );
}
