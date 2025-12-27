// App.js
import React, { useEffect } from "react";
import { View, ActivityIndicator, Text, StyleSheet } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import "react-native-gesture-handler";

import { AvatarProvider } from "./context/AvatarState";

// Member A: auth context + API helpers
import { AuthProvider, useAuth } from "./context/AuthContext";
import { setApiToken, fetchMe } from "./api";

// THEME: wrap the app with ThemeProvider
import { ThemeProvider } from "./theme";

// Screens
import LoginScreen from "./screens/auth/LoginScreen";
import SignupScreen from "./screens/auth/SignupScreen";
import OnboardingScreen from "./screens/Onboarding/OnboardingScreen";
import HomeScreen from "./screens/HomeScreen";

const Stack = createStackNavigator();

function Splash() {
  return (
    <View style={styles.splash}>
      <ActivityIndicator size="large" />
      <Text style={styles.splashText}>Starting Evania...</Text>
    </View>
  );
}

function RootNavigator() {
  const { token, me, setMe, loading } = useAuth();

  // whenever token changes, attach it to API and refresh /me
  useEffect(() => {
    if (token) {
      setApiToken(token);
      fetchMe().then(setMe).catch(() => {});
    } else {
      setApiToken(null);
    }
  }, [token, setMe]);

  if (loading) return <Splash />;

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!token ? (
          // AUTH STACK
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Signup" component={SignupScreen} />
          </>
        ) : !me?.onboardingDone ? (
          // ONBOARDING STACK
          <>
            <Stack.Screen name="Onboarding" component={OnboardingScreen} />
          </>
        ) : (
          // APP STACK
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AvatarProvider>
          <RootNavigator />
        </AvatarProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    backgroundColor: "#fff",
  },
  splashText: {
    marginTop: 12,
    fontSize: 16,
    color: "#333",
  },
});
