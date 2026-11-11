; Instalador do Windows: libera o Quadro no Ar no firewall, para os aparelhos da rede conseguirem assistir
; sem o Windows perguntar nada na primeira transmissão. Desinstalando, a regra sai junto.
; (O instalador pede permissão de administrador uma vez: é o que permite criar a regra.)

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Quadro no Ar"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Quadro no Ar" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Quadro no Ar"'
!macroend
